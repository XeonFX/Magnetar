import { useCallback } from 'react'
import { errorMessage } from '../lib/errors.ts'
import { useT } from '../lib/i18n.tsx'
import { useToast } from '../ui/toast.tsx'

/**
 * Runs a device call and turns a failure into an error toast (optionally formatted with a
 * translated template taking the message as {0}). Resolves undefined when the call failed.
 */
export function useRun() {
  const toast = useToast()
  const t = useT()
  return useCallback(async <T,>(action: () => Promise<T>, errorKey?: string): Promise<T | undefined> => {
    try {
      return await action()
    } catch (error) {
      const message = errorMessage(error)
      toast(errorKey ? t(errorKey, message) : message, 'error')
      return undefined
    }
  }, [toast, t])
}
