// Lisa Evaluator - Evaluates images for privacy/vagueness using Gemini 2.0 Flash

import {
  callOpenRouter,
  imageDataToBase64,
  parseJSONResponse,
  type ChatMessage,
} from "./openrouter";
import { SOTAError, type LisaEvaluation } from "./types";

const LISA_MODEL = "google/gemini-3-flash-preview";

const LISA_SYSTEM_PROMPT = `You are Lisa, a privacy evaluation AI. Your job is to analyze images and determine how well personally identifiable information (PII) has been redacted or obscured.

IMPORTANT: Balance privacy with image usability. The goal is to protect identity, not destroy the image.

## PII Categories (by priority)

HIGH PRIORITY - Must be fully obscured:
- Faces that could identify a specific person
- Full names, addresses, phone numbers, emails
- ID numbers (SSN, license numbers, account numbers)
- License plates that are clearly readable
- Credit cards, badges with names/photos

MEDIUM PRIORITY - Should be obscured if clearly readable:
- Partial names or initials in context
- Company logos that reveal location/employer
- Street signs or building numbers that pinpoint location

LOW PRIORITY - Usually okay to leave visible:
- Generic text (product labels, signs with common words)
- Distant/blurry faces that can't identify anyone
- Silhouettes or back-of-head views
- Text that's already too small/blurry to read

## Response Format
{
  "vaguenessScore": <number 0.0-1.0>,
  "visibleLeaks": [
    {
      "type": "<face|text|license_plate|document|other>",
      "description": "<specific description of what's visible>"
    }
  ],
  "reasoning": "<brief explanation>"
}

## Scoring Guide
- 0.0-0.2: Multiple HIGH priority items clearly visible
- 0.3-0.4: Some HIGH priority items visible, or many MEDIUM items
- 0.5-0.6: HIGH items partially obscured but still recognizable
- 0.7-0.8: HIGH items well obscured, maybe minor MEDIUM items visible
- 0.9+: Excellent privacy - only LOW priority items remain (if any)

## Key Principles
- Only report leaks for items that could ACTUALLY identify someone
- Blurry, distant, or partially obscured content is often acceptable
- An image with no people/PII should score 1.0 immediately
- Already-redacted areas (black boxes, pixelation, blur) should be credited, not flagged
- Don't flag the same area multiple times`;

interface LisaRawResponse {
  vaguenessScore: number;
  visibleLeaks: Array<{
    type: string;
    description: string;
    region?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
  reasoning: string;
}

/**
 * Evaluate an image for privacy using Lisa (Gemini 2.0 Flash)
 */
export async function evaluateWithLisa(
  apiKey: string,
  imageData: ImageData,
  signal?: AbortSignal,
): Promise<LisaEvaluation> {
  const imageBase64 = imageDataToBase64(imageData);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: LISA_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Please evaluate this image for privacy. How well is PII redacted?",
        },
        {
          type: "image_url",
          image_url: {
            url: imageBase64,
            detail: "high",
          },
        },
      ],
    },
  ];

  const response = await callOpenRouter(
    apiKey,
    LISA_MODEL,
    messages,
    {
      temperature: 0.1,
      maxTokens: 2048,
      responseFormat: { type: "json_object" },
    },
    signal,
  );

  const parsed = parseJSONResponse<LisaRawResponse>(response);

  // Validate and normalize the response
  return validateLisaResponse(parsed);
}

function validateLisaResponse(raw: LisaRawResponse): LisaEvaluation {
  // Validate vagueness score
  if (typeof raw.vaguenessScore !== "number" || isNaN(raw.vaguenessScore)) {
    throw new SOTAError("parse", "Lisa response missing vaguenessScore", false);
  }

  const vaguenessScore = Math.max(0, Math.min(1, raw.vaguenessScore));

  // Validate visible leaks array
  if (!Array.isArray(raw.visibleLeaks)) {
    raw.visibleLeaks = [];
  }

  const validTypes = [
    "face",
    "text",
    "license_plate",
    "document",
    "other",
  ] as const;

  const visibleLeaks = raw.visibleLeaks.map((leak) => {
    const type = validTypes.includes(leak.type as (typeof validTypes)[number])
      ? (leak.type as (typeof validTypes)[number])
      : "other";

    return {
      type,
      description: String(leak.description || "Unknown PII"),
      ...(leak.region && {
        region: {
          x: Number(leak.region.x) || 0,
          y: Number(leak.region.y) || 0,
          width: Number(leak.region.width) || 0,
          height: Number(leak.region.height) || 0,
        },
      }),
    };
  });

  // Validate reasoning
  const reasoning =
    typeof raw.reasoning === "string" ? raw.reasoning : "No reasoning provided";

  return {
    vaguenessScore,
    visibleLeaks,
    reasoning,
  };
}
