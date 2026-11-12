'use client'

import { Button } from '@repo/ui/components/ui/button'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthClient } from '@/hooks/useAuthClient'
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
      await clearSessionData(queryClient, (path) =>
        window.location.replace(path),
      )
    },
  })

  return (
    <Button
      variant="outline"
      onClick={() => signOutMutation.mutate()}
      disabled={signOutMutation.isPending}
    >
      {signOutMutation.isPending ? 'Signing out...' : 'Sign Out'}
    </Button>
  )
}
