/**
 * The session's half of "Send when dictation ends": a chat transcript starts the countdown only
 * when the desktop's setup reply turned the setting on, dictating again cancels it, and a
 * transcript that arrives after the user left the screen, the app or the chat stays a draft.
 *
 * Mounts the real `useMobileSessionNativeChatDictation` over the real `useMobileDictation`, with a
 * desktop that answers the setup read, the start and a finish carrying the transcript.
 */
import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type * as NativeChatSendError from './use-mobile-native-chat-send-error'

// The screen's lifecycle, driven by the tests: the app's foreground state and the route's focus.
type ScreenLifecycle = {
  appStateListener: ((state: string) => void) | null
  blur: (() => void) | null
}
const lifecycle = vi.hoisted((): ScreenLifecycle => ({ appStateListener: null, blur: null }))

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      lifecycle.appStateListener = listener
      return { remove: () => {} }
    }
  },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () => Promise.resolve({ granted: true }),
  tearDown: () => {},
  toggleRecording: () => true
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))
// Runs the focus effect like a focused screen, so the hook reads the desktop's setup on mount, and
// keeps its cleanup so a test can blur the screen.
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      React.useEffect(() => {
        const cleanup = effect()
        lifecycle.blur = () => cleanup?.()
        return cleanup
      }, [effect])
  }
})
vi.mock('../platform/haptics', () => ({ triggerError: () => {} }))
vi.mock('./use-mobile-native-chat-send-error', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeChatSendError>()),
  useMobileNativeChatSendError: () => ({
    message: null,
    show: () => {},
    clear: () => {},
    keepWhile: () => {},
    bannerMountedRef: { current: false }
  })
}))
vi.mock('./use-mobile-native-chat-readability', () => ({
  useMobileNativeChatReadability: () => true
}))
vi.mock('./use-mobile-native-chat-input-lease', () => ({
  useMobileNativeChatInputLease: () => ({
    ready: true,
    readyRef: { current: true },
    lockReason: null,
    markReady: () => {},
    clear: () => {}
  })
}))
vi.mock('./use-mobile-native-chat-controller', () => ({
  useMobileNativeChatController: () => ({
    nativeChatSession: { messages: [] },
    toggleTabChatView: () => {},
    showNativeChat: true,
    showNativeChatRef: { current: true },
    setChatComposerText: () => {}
  })
}))
vi.mock('./use-mobile-send-completion-generation', () => ({
  useMobileSendCompletionGeneration: () => () => 0
}))

import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'

type Model = ReturnType<typeof useMobileSessionNativeChatDictation>

// Stable like the screen's useState setters, so the focus effect does not rerun on every render.
const noop = (): void => {}

type Mounted = { model: { current: Model | null }; switchChat: (tabId: string) => void }

function mountAgentChatTab(client: FakeRpcClient): Mounted {
  const latest: { current: Model | null } = { current: null }

  function Probe({ tabId }: { tabId: string }): null {
    const scope = {
      hostId: 'h1',
      worktreeId: 'w1',
      client,
      connState: 'connected',
      agentSessionHostSupport: { promptCancel: true, questionAnswers: false },
      setInput: () => {},
      liveInputTerminalHandles: new Set<string>(),
      activeHandle: null,
      activeSessionTabId: tabId,
      activeSessionTab: { id: tabId, type: 'agent-session' },
      diffComments: [],
      diffCommentsRef: useRef([]),
      setShowDictationSetup: () => {},
      setDictationMode: noop,
      dictationEnabled: true,
      setDictationEnabled: noop,
      deviceTokenRef: useRef('dev'),
      dictationRouteContextRef: useRef(null),
      activeHandleRef: useRef(null),
      flushPendingLiveInputBeforeExternalSend: async () => true,
      canSend: false,
      liveInputEnabled: false,
      showToast: () => {},
      resetLiveInputFocus: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member this hook destructures; the rest of the session model is unreachable from the mic path.
    latest.current = useMobileSessionNativeChatDictation(scope as never, async () => true)
    return null
  }

  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(Probe, { tabId: 'chat1' }))
  })
  return {
    model: latest,
    switchChat: (tabId) => renderer!.update(createElement(Probe, { tabId }))
  }
}

type Request = FakeRpcClient['requests'][number]

/**
 * Answers every request the hook sends, with `setup` as the desktop's voice settings. With
 * `heldFinishes`, a finish waits there instead, so the transcript can arrive late.
 */
async function pump(
  rpc: FakeRpcClient,
  setup: Record<string, unknown>,
  heldFinishes?: Request[]
): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      if (heldFinishes && request.method === 'speech.dictation.finish') {
        heldFinishes.push(request)
        continue
      }
      const result =
        request.method === 'speech.models.list'
          ? { enabled: true, dictationMode: 'toggle', models: [], ...setup }
          : request.method === 'speech.dictation.start'
            ? { dictationId: 'd1' }
            : request.method === 'speech.dictation.finish'
              ? { text: 'send this to the agent' }
              : {}
      request.resolve({ id: 'desktop', ok: true, result })
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

async function dictateIntoChat(setup: Record<string, unknown>): Promise<Model> {
  const rpc = createFakeRpcClient()
  const { model } = mountAgentChatTab(rpc)
  await act(async () => pump(rpc, setup))
  await act(async () => {
    model.current!.startDictation()
    await pump(rpc, setup)
  })
  await act(async () => {
    void model.current!.dictation.stop()
    await pump(rpc, setup)
  })
  return model.current!
}

describe('a chat transcript and the desktop auto-send setting', () => {
  it('starts a countdown with the desktop delay when the setting is on', async () => {
    const model = await dictateIntoChat({ autoSendAfterDictation: true, autoSendDelayMs: 3000 })
    expect(model.dictationAutoSend.getSnapshot()).toMatchObject({ delayMs: 3000 })
    act(() => model.dictationAutoSend.cancel())
  })

  it('cancels the countdown when the user starts dictating again', async () => {
    const model = await dictateIntoChat({ autoSendAfterDictation: true, autoSendDelayMs: 3000 })
    act(() => model.startDictation())
    expect(model.dictationAutoSend.getSnapshot()).toBeNull()
  })

  it('starts nothing for a desktop that predates the setting', async () => {
    const model = await dictateIntoChat({})
    expect(model.dictationAutoSend.getSnapshot()).toBeNull()
  })

  const setting = { autoSendAfterDictation: true, autoSendDelayMs: 3000 }

  it.each([
    ['the app goes to the background', () => lifecycle.appStateListener?.('background')],
    ['the screen loses focus', () => lifecycle.blur?.()],
    ['the user switches chats', (mounted: Mounted) => mounted.switchChat('chat2')]
  ])('keeps a transcript that arrives after %s as a draft', async (_name, leave) => {
    const rpc = createFakeRpcClient()
    const mounted = mountAgentChatTab(rpc)
    const heldFinishes: Request[] = []
    await act(async () => pump(rpc, setting))
    await act(async () => {
      mounted.model.current!.startDictation()
      await pump(rpc, setting)
    })
    await act(async () => {
      void mounted.model.current!.dictation.stop()
      await pump(rpc, setting, heldFinishes)
    })
    expect(heldFinishes).toHaveLength(1)

    act(() => leave(mounted))
    await act(async () => {
      heldFinishes[0].resolve({ id: 'desktop', ok: true, result: { text: 'too late to send' } })
      await pump(rpc, setting)
    })

    expect(mounted.model.current!.dictationAutoSend.getSnapshot()).toBeNull()
  })
})
