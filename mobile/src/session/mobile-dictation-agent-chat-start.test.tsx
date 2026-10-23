/**
 * A mic tap in an agent chat tab, which has no terminal behind it, reaching the desktop.
 *
 * Mounts the real `useMobileSessionNativeChatDictation` over the real `useMobileDictation`: the
 * defect was the terminal-only gate between them, so a tap there returned without a word.
 */
import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type * as NativeChatSendError from './use-mobile-native-chat-send-error'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
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
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../platform/haptics', () => ({ triggerError: () => {} }))

// The native-chat surface this hook composes with, showing an agent chat. None of it is on the
// mic's path, and reaching the real modules would pull the Expo runtime in behind them.
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

/** An agent chat tab: the composer is the chat's, and there is no terminal handle to send to. */
function mountAgentChatTab(
  client: FakeRpcClient,
  connState: 'connected' | 'disconnected'
): () => void {
  const held: { start: (() => void) | null } = { start: null }

  function Probe(): null {
    const scope = {
      hostId: 'h1',
      worktreeId: 'w1',
      client,
      connState,
      agentSessionHostSupport: { promptCancel: true, questionAnswers: false },
      setInput: () => {},
      liveInputTerminalHandles: new Set<string>(),
      activeHandle: null,
      activeSessionTabId: 'chat1',
      activeSessionTab: { id: 'chat1', type: 'agent-session' },
      diffComments: [],
      diffCommentsRef: useRef([]),
      setShowDictationSetup: () => {},
      setDictationMode: () => {},
      dictationEnabled: true,
      setDictationEnabled: () => {},
      deviceTokenRef: useRef('dev'),
      dictationRouteContextRef: useRef(null),
      activeHandleRef: useRef(null),
      flushPendingLiveInputBeforeExternalSend: async () => true,
      // The terminal gate: closed, because no terminal is active.
      canSend: false,
      liveInputEnabled: false,
      showToast: () => {},
      resetLiveInputFocus: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member this hook destructures; the rest of the session model is unreachable from the mic path.
    const model = useMobileSessionNativeChatDictation(scope as never, async () => true)
    held.start = model.startDictation
    return null
  }

  act(() => {
    create(createElement(Probe))
  })
  return () => held.start?.()
}

/** Taps the mic and answers every request it sends, returning the methods the desktop saw. */
async function tapAndCollectMethods(tap: () => void, rpc: FakeRpcClient): Promise<string[]> {
  const methods: string[] = []
  await act(async () => {
    tap()
    for (let round = 0; round < 8; round += 1) {
      for (const request of rpc.requests.splice(0)) {
        methods.push(request.method)
        request.resolve({ id: 'desktop', ok: true, result: { dictationId: 'd1' } })
      }
      await Promise.resolve()
      await Promise.resolve()
    }
  })
  return methods
}

describe('a mic tap in an agent chat tab', () => {
  it('asks the desktop to start dictation', async () => {
    const rpc = createFakeRpcClient()
    const tap = mountAgentChatTab(rpc, 'connected')
    expect(await tapAndCollectMethods(tap, rpc)).toContain('speech.dictation.start')
  })

  it('stays put while the desktop is disconnected', async () => {
    const rpc = createFakeRpcClient()
    const tap = mountAgentChatTab(rpc, 'disconnected')
    expect(await tapAndCollectMethods(tap, rpc)).not.toContain('speech.dictation.start')
  })
})
