import { Router } from 'express'
import { asyncHandler } from '../lib/http.js'

// API ecosystem documentation and integration endpoints. Serves as the foundation
// for third-party integrations (Slack, Zapier, Make, etc.) and future SDK.
//
// The primary integration surface is webhooks + a minimal REST API:
// - POST /api/webhooks registers an endpoint for event delivery
// - GET /api/lead-scoring/* provides deterministic lead qualification
// - Webhook events enable real-time Slack/Zapier automation

export const integrationsRouter = Router()

// GET /api/integrations/docs — Integration guide + webhook payload samples
integrationsRouter.get(
  '/docs',
  asyncHandler(async (_req, res) => {
    const docs = {
      title: 'ACAOS Integration API',
      version: '1.0.0',
      description: 'Real-time lead qualification and sales automation via webhooks and REST APIs',

      gettingStarted: {
        step1: 'Generate API token in Workspace Settings → API Keys',
        step2: 'Register webhook endpoint: POST /api/webhooks with HTTPS URL + event types',
        step3: 'Implement signature verification (Stripe-compatible HMAC-SHA256)',
        step4: 'Handle incoming JSON envelopes from ACAOS',
      },

      webhookEvents: [
        {
          type: 'lead.qualified',
          description: 'Lead reached HOT tier (score >= 72)',
          tier: 'enriched',
          usedBy: ['Slack notifications', 'CRM enrichment', 'Lead routing'],
          sampleData: {
            leadId: 'lead_xyz',
            businessName: 'Acme Corp',
            email: 'john@acme.com',
            score: 78,
            tier: 'HOT',
            topReasons: [
              'Core ICP industry match',
              'Active hiring signal',
            ],
          },
        },
        {
          type: 'reply.received',
          description: 'Prospect replied to outreach',
          tier: 'core',
          usedBy: ['Inbox Assistant', 'CRM sync', 'Slack alerts'],
          sampleData: {
            replyId: 'reply_123',
            toEmail: 'john@acme.com',
            subject: 'Re: Great question...',
            replyIntent: 'INTERESTED',
            replyConfidence: 0.92,
            replySummary: 'Interested in demo',
            replyUrgency: 'this_week',
          },
        },
        {
          type: 'campaign.sent',
          description: 'Outreach sent to prospect',
          tier: 'core',
          usedBy: ['Campaign tracking', 'Sequence workflows'],
          sampleData: {
            campaignId: 'campaign_456',
            toEmail: 'john@acme.com',
            subject: 'Opening new market...',
            sentAt: '2026-09-19T09:00:00Z',
          },
        },
        {
          type: 'meeting.booked',
          description: 'Demo/call scheduled (outcome achieved)',
          tier: 'core',
          usedBy: ['Revenue tracking', 'Success reporting'],
          sampleData: {
            leadId: 'lead_xyz',
            businessName: 'Acme Corp',
            email: 'john@acme.com',
            scheduledFor: '2026-09-25T14:00:00Z',
          },
        },
      ],

      apiEndpoints: [
        {
          method: 'POST',
          path: '/api/webhooks',
          description: 'Register webhook endpoint',
          requiredFields: ['workspaceId', 'url', 'eventTypes'],
          returns: 'endpoint config + signing secret (one-time return)',
        },
        {
          method: 'GET',
          path: '/api/webhooks?workspaceId=...',
          description: 'List registered webhook endpoints',
          returns: 'array of endpoints (secrets masked)',
        },
        {
          method: 'POST',
          path: '/api/lead-scoring/score',
          description: 'Score single lead with explanation',
          requiredFields: ['workspaceId', 'businessName'],
          optionalFields: ['email', 'category', 'notes', 'aiSummary'],
          returns: 'score + signals breakdown + human-readable reasons',
        },
        {
          method: 'POST',
          path: '/api/lead-scoring/batch',
          description: 'Score up to 100 leads (bulk import, CSV)',
          requiredFields: ['workspaceId', 'leads'],
          returns: 'array of scored leads with explanations',
        },
        {
          method: 'GET',
          path: '/api/lead-scoring/stats?workspaceId=...',
          description: 'Workspace scoring model performance metrics',
          returns: 'reply rate, score correlation, learning loop status',
        },
      ],

      integrationPatterns: [
        {
          name: 'Slack Lead Alerts',
          description: 'Post HOT leads to Slack channel in real-time',
          flow: [
            '1. Create Slack App with incoming webhooks',
            '2. Register Slack webhook URL in ACAOS',
            '3. Subscribe to lead.qualified events',
            '4. Slack bot receives JSON, posts formatted message',
          ],
        },
        {
          name: 'Zapier Reply Routing',
          description: 'Route incoming replies to CRM or email tool',
          flow: [
            '1. Create Zapier Zap with ACAOS as trigger',
            '2. Choose reply.received event type',
            '3. Connect to CRM, email, or other apps',
            '4. Zapier maps reply data to those tools',
          ],
        },
        {
          name: 'CSV Bulk Scoring',
          description: 'Score 100 leads from CSV in one batch call',
          flow: [
            '1. Load leads from CSV',
            '2. POST to /api/lead-scoring/batch',
            '3. Receive scored results with explanations',
            '4. Export scores back to CRM or spreadsheet',
          ],
        },
      ],

      security: {
        scheme: 'HMAC-SHA256 (Stripe-compatible)',
        signatureHeader: 'Acaos-Signature: t=<timestamp>,v1=<signature>',
        body: '<timestamp>.<json>',
        verification: 'Constant-time compare (timing-safe)',
        tlsRequirement: 'https:// only, port 443',
        toleranceSeconds: 300,
      },

      rateLimits: {
        webhookDelivery: '1000 deliveries/hour per workspace',
        leadScoringBatch: '100 leads/request, 1000 leads/hour',
        apiGeneral: '600 requests/minute per API token',
      },

      documentation: {
        sdks: 'JavaScript: npm install @acaos/sdk; Python: pip install acaos',
        examples: 'https://github.com/acaos/integrations',
        support: 'https://docs.acaos.com/integrations',
      },
    }

    res.json(docs)
  })
)

// GET /api/integrations/slack-manifest — Slack App Manifest for easy installation
integrationsRouter.get(
  '/slack-manifest',
  asyncHandler(async (_req, res) => {
    const manifest = {
      _metadata: {
        major_version: 1,
        minor_version: 1,
      },
      display_information: {
        name: 'ACAOS Sales Assistant',
        description: 'Real-time lead qualification and reply alerts in Slack',
        background_color: '#000000',
        long_description: 'Get instant Slack notifications when prospects reply to outreach or reach HOT lead status.',
      },
      features: {
        bot_user: {
          display_name: 'ACAOS',
          always_online: true,
        },
      },
      oauth_config: {
        scopes: {
          bot: ['chat:write', 'chat:write.public', 'channels:read'],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: ['app_mention', 'message.im'],
        },
      },
    }
    res.json(manifest)
  })
)
