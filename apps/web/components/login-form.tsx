'use client'

import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import { Notice } from '@repo/ui/components/ds/feedback'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { toast } from '@repo/ui/components/ui/sonner'
import { useAuthClient } from '@/hooks/useAuthClient'

export default function LoginForm() {
  const router = useRouter()
  const authClient = useAuthClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem('sign-out-confirmed') !== 'yes') return
      window.sessionStorage.removeItem('sign-out-confirmed')
      toast.success('Signed out')
    } catch {
      // Storage is optional for the sign-out receipt.
    }
  }, [])

  const loginMutation = useMutation({
    mutationFn: async () => {
      const response = await authClient.signIn.email({
        email,
        password,
      })

      if (response.error) {
        throw response.error
      }
    },
    onSuccess: async () => {
      toast.success('Signed in')
      router.replace('/albums')
      router.refresh()
    },
  })

  return (
    <form
      className="sec-stack"
      onSubmit={(event) => {
        event.preventDefault()
        loginMutation.mutate()
      }}
    >
      <div className="ds-field">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          controlSize="md"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
        />
      </div>

      <div className="ds-field">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          controlSize="md"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      {loginMutation.isError && (
        <Notice tone="danger">
          Could not sign in. Check the email and password.
        </Notice>
      )}

      <Button
        size="md"
        variant="primary"
        type="submit"
        feedback={mutationFeedback(loginMutation, {
          pending: 'Signing in…',
          success: 'Signed in',
          error: 'Sign-in failed · retry',
        })}
        disabled={
          loginMutation.isPending || email.length === 0 || password.length === 0
        }
      >
        Sign in
      </Button>
    </form>
  )
}
