// Ralph Iterator - Plans redactions using vision model based on Lisa's evaluation

import {
  callOpenRouter,
  imageDataToBase64,
  parseJSONResponse,
  type ChatMessage,
} from "./openrouter";
import {
  SOTAError,
  type LisaEvaluation,
  type RalphPlan,
  type RalphRedaction,
} from "./types";

// Using Quasar Alpha - good vision + reasoning model
const RALPH_MODEL = "opengvlab/internvl3-78b";

function getRalphSystemPrompt(imageWidth: number, imageHeight: number): string {
  return `You are Ralph, a privacy redaction planning AI. Your job is to plan MINIMAL, SURGICAL redactions to hide specific PII while preserving as much of the image as possible.

Image dimensions: ${imageWidth}x${imageHeight} pixels

## Core Principle: LESS IS MORE
The goal is to make a person unidentifiable, NOT to destroy the image. A good redaction:
- Covers ONLY the specific PII item (face, text, plate)
- Uses the SMALLEST area necessary
- Preserves image context and composition
- Allows viewers to understand what the image depicts

## Available Styles
- "pixelate": Best for faces and license plates (preserves shape/context)
- "solid": Best for text that must be completely hidden
- "blur": Best for subtle obscuring of background details

## Response Format
{
  "redactions": [
    {
      "style": "<solid|pixelate|blur>",
      "x": <left edge in pixels>,
      "y": <top edge in pixels>,
      "width": <width in pixels>,
      "height": <height in pixels>,
      "intensity": <1-100>,
      "reason": "<specific PII this covers>"
    }
  ],
  "explanation": "<brief overview>"
}

## STRICT Rules
1. ONLY redact items Lisa specifically identified as leaks
2. Each redaction should target ONE specific item
3. Keep redactions TIGHT - add only 5-10px margin around the actual PII
4. Maximum recommended sizes:
   - Faces: typically 50-150px per dimension
   - Text lines: typically 20-40px height
   - License plates: typically 80-150px width, 30-50px height
5. If Lisa's score is already 0.7+, be VERY conservative - only fix clear issues
6. NEVER redact more than 30% of the image area total
7. If no specific leaks are listed, return EMPTY redactions array

## Intensity Guide
- 40-50: Light obscuring (distant faces, background text)
- 50-60: Standard (most faces, readable text)
- 70-80: Strong (close-up faces, sensitive documents)
- 90-100: Maximum (only for critical items like ID numbers)

## What NOT to Redact
- Areas already redacted (black boxes, existing pixelation)
- Generic/non-identifying text (brand names, common signs)
- Distant figures that aren't recognizable
- The same area twice

Coordinates must be within bounds (0-${imageWidth - 1} for x, 0-${imageHeight - 1} for y)`;
}

interface RalphRawResponse {
  redactions: Array<{
    style: string;
    x: number;
    y: number;
    width: number;
    height: number;
    intensity: number;
    reason: string;
  }>;
  explanation: string;
}

/**
 * Plan redactions using Ralph based on Lisa's evaluation
 */
export async function planWithRalph(
  apiKey: string,
  imageData: ImageData,
  evaluation: LisaEvaluation,
  signal?: AbortSignal,
): Promise<RalphPlan> {
  // If Lisa found no specific leaks, don't redact anything
  // This prevents aggressive over-redaction when the score is just below target
  if (evaluation.visibleLeaks.length === 0) {
    return {
      redactions: [],
      explanation:
        "No specific PII leaks identified - no additional redactions needed.",
    };
  }

  // If score is already very high, also skip
  if (evaluation.vaguenessScore >= 0.9) {
    return {
      redactions: [],
      explanation:
        "Privacy score is already excellent (90%+) - no changes needed.",
    };
  }

  const imageBase64 = imageDataToBase64(imageData);

  const lisaFeedback = formatLisaFeedback(evaluation);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: getRalphSystemPrompt(imageData.width, imageData.height),
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Lisa's privacy evaluation:\n${lisaFeedback}\n\nPlease analyze this image and plan redactions to cover the remaining PII that Lisa identified.`,
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
    RALPH_MODEL,
    messages,
    {
      temperature: 0.2,
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
    },
    signal,
  );

  const parsed = parseJSONResponse<RalphRawResponse>(response);

  return validateRalphResponse(parsed, imageData.width, imageData.height);
}

function formatLisaFeedback(evaluation: LisaEvaluation): string {
  const scorePercent = (evaluation.vaguenessScore * 100).toFixed(0);
  let feedback = `Privacy Score: ${scorePercent}%\n`;
  feedback += `Reasoning: ${evaluation.reasoning}\n`;

  // Add guidance based on current score
  if (evaluation.vaguenessScore >= 0.7) {
    feedback += `\n⚠️ SCORE IS ALREADY ${scorePercent}% - BE VERY CONSERVATIVE. Only address clear, specific issues.\n`;
  } else if (evaluation.vaguenessScore >= 0.5) {
    feedback += `\nScore is moderate. Focus on the most important leaks first.\n`;
  }

  if (evaluation.visibleLeaks.length > 0) {
    feedback += "\nSpecific PII leaks to address:\n";
    for (const leak of evaluation.visibleLeaks) {
      feedback += `- ${leak.type}: ${leak.description}`;
      if (leak.region) {
        feedback += ` (approx. at x:${leak.region.x}, y:${leak.region.y}, ${leak.region.width}x${leak.region.height})`;
      }
      feedback += "\n";
    }
  } else {
    feedback +=
      "\n✓ No specific leaks identified. Return empty redactions array - the image is sufficiently private.\n";
  }

  return feedback;
}

function validateRalphResponse(
  raw: RalphRawResponse,
  imageWidth: number,
  imageHeight: number,
): RalphPlan {
  if (!Array.isArray(raw.redactions)) {
    raw.redactions = [];
  }

  const validStyles = ["solid", "pixelate", "blur"] as const;

  const redactions: RalphRedaction[] = raw.redactions
    .map((r) => {
      // Validate style
      const style = validStyles.includes(
        r.style as (typeof validStyles)[number],
      )
        ? (r.style as (typeof validStyles)[number])
        : "solid";

      // Validate and clamp coordinates
      let x = Math.round(Number(r.x) || 0);
      let y = Math.round(Number(r.y) || 0);
      let width = Math.round(Number(r.width) || 50);
      let height = Math.round(Number(r.height) || 50);

      // Clamp to image bounds
      x = Math.max(0, Math.min(imageWidth - 1, x));
      y = Math.max(0, Math.min(imageHeight - 1, y));
      width = Math.max(1, Math.min(imageWidth - x, width));
      height = Math.max(1, Math.min(imageHeight - y, height));

      // Validate intensity
      const intensity = Math.max(
        1,
        Math.min(100, Math.round(Number(r.intensity) || 70)),
      );

      // Validate reason
      const reason = typeof r.reason === "string" ? r.reason : "Redacting PII";

      return { style, x, y, width, height, intensity, reason };
    })
    .filter((r) => r.width > 0 && r.height > 0); // Filter out zero-size redactions

  const explanation =
    typeof raw.explanation === "string"
      ? raw.explanation
      : "Redaction plan generated";

  return { redactions, explanation };
}
