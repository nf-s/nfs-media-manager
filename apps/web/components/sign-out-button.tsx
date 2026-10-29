'use client'

import { Button } from '@repo/ui/components/ui/button'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useAuthClient } from '@/hooks/useAuthClient'

export default function SignOutButton() {
  const router = useRouter()
  const authClient = useAuthClient()

  const signOutMutation = useMutation({
    mutationFn: async () => {
      const response = await authClient.signOut()

      if (response.error) {
        throw response.error
      }
    },
    onSuccess: async () => {
      router.replace('/login')
      router.refresh()
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
