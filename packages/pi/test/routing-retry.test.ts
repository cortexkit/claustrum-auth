import { expect, test } from 'bun:test'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/compat'
import {
  routingDeclinedText,
  routingNoAnswerText,
} from '../../core/src/routing.ts'

test('routing fixed texts are not retryable by Pi actual retry classifier', () => {
  for (const errorMessage of [routingDeclinedText, routingNoAnswerText]) {
    expect(
      isRetryableAssistantError({
        stopReason: 'error',
        errorMessage,
      } as Parameters<typeof isRetryableAssistantError>[0]),
    ).toBe(false)
  }
  expect(
    isRetryableAssistantError({
      stopReason: 'error',
      errorMessage: 'connection refused',
    } as Parameters<typeof isRetryableAssistantError>[0]),
  ).toBe(true)
})
