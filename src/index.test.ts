import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture everything the plugin sends, without touching the network.
const captured: Array<{ event: string; properties: Record<string, unknown> }> = []

vi.mock('posthog-node', () => ({
    PostHog: class {
        capture(e: { event: string; properties: Record<string, unknown> }) {
            captured.push(e)
        }
        async flush() {}
        async shutdown() {}
    },
}))

import { PostHogPlugin } from './index.js'

type AnyEvent = { type: string; properties: Record<string, unknown> }

async function run(events: AnyEvent[]) {
    process.env.POSTHOG_API_KEY = 'phc_test'
    const hooks = (await PostHogPlugin({} as never)) as { event: (i: { event: AnyEvent }) => Promise<void> }
    for (const event of events) await hooks.event({ event })
}

const S = 'ses_test'
const U = 'msg_user_1'
const A = 'msg_asst_1'

beforeEach(() => {
    captured.length = 0
})

describe('trace state machine (real OpenCode event ordering)', () => {
    it('captures input and model even when the user message.updated repeats (regression: trace reset)', async () => {
        // OpenCode emits message.updated for the same user message several times
        // per turn. A repeat must not reset the trace and wipe accumulated state.
        await run([
            {
                type: 'message.updated',
                properties: { info: { role: 'user', id: U, sessionID: S, time: { created: 1 }, agent: 'build' } },
            },
            {
                type: 'message.part.updated',
                properties: { part: { type: 'text', messageID: U, sessionID: S, text: 'tell me a joke' } },
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        id: A,
                        sessionID: S,
                        modelID: 'gpt-5.4-mini',
                        providerID: 'openai',
                        time: { created: 1 },
                    },
                },
            },
            // duplicate user update — previously reset the trace
            {
                type: 'message.updated',
                properties: { info: { role: 'user', id: U, sessionID: S, time: { created: 1 }, agent: 'build' } },
            },
            { type: 'message.part.updated', properties: { part: { type: 'step-start', sessionID: S, messageID: A } } },
            {
                type: 'message.part.updated',
                properties: {
                    part: { type: 'text', messageID: A, sessionID: S, text: 'Because light attracts bugs.' },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'step-finish',
                        sessionID: S,
                        messageID: A,
                        tokens: { input: 22436, output: 18, reasoning: 0, cache: { read: 0, write: 0 } },
                        cost: 0,
                        reason: 'stop',
                    },
                },
            },
            // another duplicate user update after step-finish
            {
                type: 'message.updated',
                properties: { info: { role: 'user', id: U, sessionID: S, time: { created: 1 }, agent: 'build' } },
            },
            { type: 'session.idle', properties: { sessionID: S } },
        ])

        const gen = captured.find((e) => e.event === '$ai_generation')
        const trace = captured.find((e) => e.event === '$ai_trace')

        expect(gen).toBeDefined()
        expect(gen!.properties.$ai_model).toBe('gpt-5.4-mini')
        expect(gen!.properties.$ai_provider).toBe('openai')
        expect(gen!.properties.$ai_input).toEqual([{ role: 'user', content: 'tell me a joke' }])

        expect(trace).toBeDefined()
        expect(trace!.properties.$ai_input_state).toBe('tell me a joke')

        // exactly one trace per user message (no duplicate traces from repeats)
        expect(captured.filter((e) => e.event === '$ai_trace')).toHaveLength(1)
    })

    it('deduplicates streamed reasoning and resets it between steps', async () => {
        await run([
            {
                type: 'message.updated',
                properties: { info: { role: 'user', id: U, sessionID: S, time: { created: 1 }, agent: 'build' } },
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        id: A,
                        sessionID: S,
                        modelID: 'kimi-k2.6',
                        providerID: 'opencode',
                        time: { created: 1 },
                    },
                },
            },
            { type: 'message.part.updated', properties: { part: { type: 'step-start', sessionID: S, messageID: A } } },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'reasoning',
                        id: 'reasoning-1',
                        sessionID: S,
                        messageID: A,
                        text: 'Need inspect',
                        time: { start: 2 },
                    },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'reasoning',
                        id: 'reasoning-1',
                        sessionID: S,
                        messageID: A,
                        text: 'Need inspect the file',
                        time: { start: 2 },
                    },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'tool',
                        id: 'tool-1',
                        sessionID: S,
                        messageID: A,
                        callID: 'call-1',
                        tool: 'read',
                        state: {
                            status: 'completed',
                            input: { path: 'README.md' },
                            output: 'contents',
                            title: 'Read README.md',
                            metadata: {},
                            time: { start: 3, end: 4 },
                        },
                    },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'step-finish',
                        sessionID: S,
                        messageID: A,
                        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
                        cost: 0,
                        reason: 'tool-calls',
                    },
                },
            },
            { type: 'message.part.updated', properties: { part: { type: 'step-start', sessionID: S, messageID: A } } },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'reasoning',
                        id: 'reasoning-2',
                        sessionID: S,
                        messageID: A,
                        text: 'Now answer',
                        time: { start: 5 },
                    },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'step-finish',
                        sessionID: S,
                        messageID: A,
                        tokens: { input: 120, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
                        cost: 0,
                        reason: 'stop',
                    },
                },
            },
            { type: 'session.idle', properties: { sessionID: S } },
        ])

        const generations = captured.filter((event) => event.event === '$ai_generation')
        expect(generations).toHaveLength(2)
        expect(generations[0].properties.$ai_reasoning).toBe('Need inspect the file')
        expect(generations[1].properties.$ai_reasoning).toBe('Now answer')
    })
})
