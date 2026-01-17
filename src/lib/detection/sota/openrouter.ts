// OpenRouter API client for Ralph-Lisa Loop

import { SOTAError, type APIErrorType } from "./types";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export interface OpenRouterOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" };
}

interface OpenRouterResponse {
  id: string;
  choices: {
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Convert ImageData to a base64 data URL for sending to vision models
 */
export function imageDataToBase64(imageData: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Make a chat completion request to OpenRouter
 */
export async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  options: OpenRouterOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 4096,
    ...(options.responseFormat && { response_format: options.responseFormat }),
  };

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": window.location.origin,
        "X-Title": "Redactr",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new SOTAError("network", "Request was cancelled", false);
    }
    throw new SOTAError("network", "Failed to connect to OpenRouter", true);
  }

  if (!response.ok) {
    const errorType = mapStatusToErrorType(response.status);
    let errorMessage = `OpenRouter API error: ${response.status}`;

    try {
      const errorBody = await response.json();
      if (errorBody.error?.message) {
        errorMessage = errorBody.error.message;
      }
    } catch {
      // Ignore JSON parse errors for error body
    }

    throw new SOTAError(
      errorType,
      errorMessage,
      errorType === "rate_limit" || errorType === "server",
    );
  }

  let data: OpenRouterResponse;
  try {
    data = await response.json();
  } catch {
    throw new SOTAError("parse", "Failed to parse OpenRouter response", false);
  }

  if (!data.choices?.[0]?.message?.content) {
    throw new SOTAError("parse", "Empty response from OpenRouter", true);
  }

  return data.choices[0].message.content;
}

function mapStatusToErrorType(status: number): APIErrorType {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "unknown";
}

/**
 * Parse JSON from a response that might have markdown code fences
 */
export function parseJSONResponse<T>(content: string): T {
  // Remove markdown code fences if present
  let jsonStr = content.trim();

  // Handle ```json ... ``` format
  const jsonFenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonFenceMatch) {
    jsonStr = jsonFenceMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new SOTAError(
      "parse",
      `Failed to parse JSON response: ${err instanceof Error ? err.message : "unknown error"}`,
      false,
    );
  }
}
