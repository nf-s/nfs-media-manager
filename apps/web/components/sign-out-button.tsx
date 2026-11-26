'use client'

import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthClient } from '@/hooks/useAuthClient'
import { forgetWorkspace } from '@/utils/workspace-tabs'
import { clearSessionData } from '@/utils/logout'

export default function SignOutButton() {
  const queryClient = useQueryClient()
  const authClient = useAuthClient()

  const signOutMutation = useMutation({
    mutationFn: async () => {
      const response = await authClient.signOut()

      if (response.error) {
        throw response.error
      }
    },
    onSuccess: async () => {
      forgetWorkspace()
      await clearSessionData(queryClient, (path) => {
        try {
          window.sessionStorage.setItem('sign-out-confirmed', 'yes')
        } catch {
          // Document navigation also works when storage is unavailable.
        }
        window.location.replace(path)
      })
    },
  })

  return (
    <Button
      size="md"
      feedback={mutationFeedback(signOutMutation, {
        pending: 'Signing out…',
        success: 'Signed out',
        error: 'Sign-out failed · retry',
      })}
      onClick={() => signOutMutation.mutate()}
      disabled={signOutMutation.isPending}
    >
      Sign out
    </Button>
  )
}
