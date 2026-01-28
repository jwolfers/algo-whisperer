const express = require('express');
const { openai, loadActivePrompt, parseOpenAIError } = require('../lib/openai');
const { aiRateLimit } = require('../lib/rate-limit');

const router = express.Router();

// Helper function to group consecutive transcript segments by the same speaker
// Creates cleaner paragraphs instead of individual snippets with repeated speaker labels
function groupTranscriptBySpeaker(transcript) {
  if (!transcript || transcript.length === 0) return '';

  const groups = [];
  let currentGroup = { speaker: transcript[0].speaker, texts: [transcript[0].text] };

  for (let i = 1; i < transcript.length; i++) {
    const seg = transcript[i];
    if (seg.speaker === currentGroup.speaker) {
      // Same speaker, append text to current group
      currentGroup.texts.push(seg.text);
    } else {
      // Different speaker, save current group and start new one
      groups.push(currentGroup);
      currentGroup = { speaker: seg.speaker, texts: [seg.text] };
    }
  }
  // Don't forget the last group
  groups.push(currentGroup);

  // Format as "Speaker:\nParagraph text\n\n"
  return groups
    .map(g => `${g.speaker}:\n${g.texts.join(' ')}`)
    .join('\n\n');
}

// Store conversation/response IDs for maintaining context
// Each entry has { responseId, createdAt } for TTL cleanup
const conversationState = new Map();
const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Cleanup expired conversations every 30 minutes (matches 2h TTL better)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [sessionId, data] of conversationState.entries()) {
    if (now - data.createdAt > CONVERSATION_TTL_MS) {
      conversationState.delete(sessionId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} expired conversation states`);
  }
}, 30 * 60 * 1000);

// Generate YouTube metadata endpoint (rate limited - uses AI)
router.post('/generate', aiRateLimit, async (req, res) => {
  const { transcript, settings, sessionId, previousResponseId } = req.body;

  if (!transcript) {
    return res.status(400).json({ error: 'Missing transcript' });
  }

  try {
    // Load metadata generation prompts from prompts library
    const prompts = loadActivePrompt('metadata');

    // Calculate clip duration from transcript timestamps
    const lastSegment = transcript[transcript.length - 1];
    const durationSeconds = lastSegment?.end || 0;
    const durationMinutes = Math.floor(durationSeconds / 60);
    const durationRemainderSeconds = Math.floor(durationSeconds % 60);
    const durationStr = `${durationMinutes} min ${durationRemainderSeconds} seconds`;

    // Combine transcript into text, grouping consecutive segments by the same speaker
    // This creates cleaner paragraphs instead of individual snippets
    const transcriptText = groupTranscriptBySpeaker(transcript);

    // Get settings with defaults
    const numTitles = settings?.numTitles || 20;
    const numDescriptions = settings?.numDescriptions || 5;
    const numThumbnailTitles = settings?.numThumbnailTitles || 20;
    const model = settings?.chatModel || 'gpt-4o';

    // Build the system instruction with all formatting guidelines
    const systemPrompt = `${prompts.system_prompt}

You will receive a transcript of an interview video. Based on that transcript, generate:
1. ${numTitles} suggested YouTube video titles
2. ${numDescriptions} suggested YouTube video descriptions
3. ${numThumbnailTitles} suggested thumbnail titles (short, punchy phrases for thumbnails)

${prompts.title_prompt}

${prompts.description_prompt}

${prompts.thumbnail_title_prompt}
`;

    // Build the user prompt - just the transcript
    const userPrompt = `Transcript follows (Clip duration: ${durationStr})

${transcriptText}`;

    // Define structured output schema for guaranteed JSON format
    const outputSchema = {
      type: 'object',
      properties: {
        titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'YouTube video title suggestions'
        },
        descriptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'YouTube video description suggestions'
        },
        thumbnailTitles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short thumbnail text overlay suggestions'
        }
      },
      required: ['titles', 'descriptions', 'thumbnailTitles'],
      additionalProperties: false
    };

    // Use Responses API for stateful conversation with structured outputs
    const responseParams = {
      model,
      instructions: systemPrompt,
      input: userPrompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'metadata_response',
          strict: true,
          schema: outputSchema
        }
      }
    };

    // Chain to previous response if available (for follow-up requests)
    const prevId = previousResponseId || conversationState.get(sessionId)?.responseId;
    if (prevId) {
      responseParams.previous_response_id = prevId;
    }

    console.log('=== OpenAI Responses API Call ===');
    console.log('Model:', model);
    console.log('Previous Response ID:', prevId || 'none');
    console.log('Transcript length:', transcriptText.length, 'characters');
    console.log('Requesting:', numTitles, 'titles,', numDescriptions, 'descriptions,', numThumbnailTitles, 'thumbnail titles');

    const response = await openai.responses.create(responseParams);

    console.log('Response ID:', response.id);
    console.log('Usage:', JSON.stringify(response.usage || {}));

    // Store response ID for future conversation continuity
    if (sessionId) {
      conversationState.set(sessionId, { responseId: response.id, createdAt: Date.now() });
    }

    // Extract the text content from the response using SDK convenience property
    const outputText = response.output_text;

    let metadata;
    try {
      metadata = JSON.parse(outputText || '{}');
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError.message);
      return res.status(500).json({
        error: 'AI returned invalid JSON response',
      });
    }

    console.log('Generated:', metadata.titles?.length || 0, 'titles,', metadata.descriptions?.length || 0, 'descriptions,', metadata.thumbnailTitles?.length || 0, 'thumbnail titles');

    res.json({
      success: true,
      metadata,
      responseId: response.id, // Return for potential follow-up
    });
  } catch (error) {
    console.error('Metadata generation error:', error.message);
    const parsedError = parseOpenAIError(error);
    res.status(500).json({
      error: parsedError.userMessage,
      billingUrl: parsedError.billingUrl,
      isBillingError: parsedError.isBillingError,
    });
  }
});

// Follow-up endpoint for refining metadata suggestions (rate limited - uses AI)
router.post('/generate/refine', aiRateLimit, async (req, res) => {
  const { sessionId, previousResponseId, feedback, settings } = req.body;

  if (!previousResponseId && !conversationState.get(sessionId)?.responseId) {
    return res.status(400).json({ error: 'No previous conversation to refine' });
  }

  try {
    const prompts = loadActivePrompt('metadata');
    const model = settings?.chatModel || 'gpt-4o';
    const prevId = previousResponseId || conversationState.get(sessionId)?.responseId;

    console.log('Refinement request - Model:', model, 'Previous ID:', prevId);

    const response = await openai.responses.create({
      model,
      instructions: prompts.system_prompt,
      previous_response_id: prevId,
      input: feedback,
      text: {
        format: { type: 'json_object' }
      }
    });

    console.log('Refinement response ID:', response.id);

    // Update stored response ID
    if (sessionId) {
      conversationState.set(sessionId, { responseId: response.id, createdAt: Date.now() });
    }

    const outputText = response.output_text;

    let metadata;
    try {
      metadata = JSON.parse(outputText || '{}');
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError.message);
      return res.status(500).json({
        error: 'AI returned invalid JSON response',
      });
    }

    res.json({
      success: true,
      metadata,
      responseId: response.id,
    });
  } catch (error) {
    console.error('Refinement error:', error.message);
    const parsedError = parseOpenAIError(error);
    res.status(500).json({
      error: parsedError.userMessage,
      billingUrl: parsedError.billingUrl,
      isBillingError: parsedError.isBillingError,
    });
  }
});

// Summarize descriptions endpoint - generates distinguishing labels for each description
router.post('/generate/summarize-descriptions', aiRateLimit, async (req, res) => {
  const { descriptions, settings } = req.body;

  if (!descriptions || !Array.isArray(descriptions) || descriptions.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid descriptions array' });
  }

  try {
    const model = settings?.chatModel || 'gpt-4o';

    // Build the prompt for summarizing descriptions
    const descriptionsText = descriptions
      .map((desc, i) => `DESCRIPTION ${i + 1}:\n${desc}`)
      .join('\n\n---\n\n');

    const userPrompt = `I have ${descriptions.length} different YouTube video descriptions for the same video. I need you to:

1. First, write a single sentence (15-25 words) summarizing what this video is about based on reading all the descriptions.

2. For each description, write a distinguishing summary (up to 25 words) that captures what makes that particular description UNIQUE compared to the others. Focus on:
   - What angle or perspective does it emphasize?
   - What tone does it take (e.g., urgent, analytical, conversational)?
   - What aspect of the content does it highlight?
   - Who or what is the central focus?

The labels should help someone quickly understand the key difference between each option.

Here are the descriptions:

${descriptionsText}`;

    // Define structured output schema for description summaries
    const summarySchema = {
      type: 'object',
      properties: {
        videoSummary: {
          type: 'string',
          description: 'A single sentence (15-25 words) summarizing what the video is about'
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Distinguishing summaries (up to 25 words each) for each description'
        }
      },
      required: ['videoSummary', 'labels'],
      additionalProperties: false
    };

    console.log('Description summary request - Model:', model, 'Descriptions:', descriptions.length);

    const response = await openai.responses.create({
      model,
      instructions: 'You are an expert at analyzing and comparing text. Be concise and insightful.',
      input: userPrompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'description_summary',
          strict: true,
          schema: summarySchema
        }
      }
    });

    const outputText = response.output_text;

    let result;
    try {
      result = JSON.parse(outputText || '{}');
    } catch (parseError) {
      console.error('Failed to parse summary response:', parseError.message);
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    res.json({
      success: true,
      videoSummary: result.videoSummary,
      labels: result.labels,
    });
  } catch (error) {
    console.error('Description summary error:', error.message);
    const parsedError = parseOpenAIError(error);
    res.status(500).json({
      error: parsedError.userMessage,
      billingUrl: parsedError.billingUrl,
      isBillingError: parsedError.isBillingError,
    });
  }
});

module.exports = router;
