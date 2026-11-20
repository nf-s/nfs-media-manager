'use client'

import { Button } from '@repo/ui/components/ui/button'
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
      await clearSessionData(queryClient, (path) =>
        window.location.replace(path),
      )
    },
  })

  return (
    <Button
      size="md"
      onClick={() => signOutMutation.mutate()}
      disabled={signOutMutation.isPending}
    >
      {signOutMutation.isPending ? 'Signing out...' : 'Sign out'}
    </Button>
  )
}
