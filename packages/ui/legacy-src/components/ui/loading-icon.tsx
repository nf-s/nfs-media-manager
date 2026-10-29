import { Loader2Icon } from 'lucide-react'

export const LoadingIcon = ({ children }: { children?: React.ReactNode }) => (
  <Loader2Icon className="size-4 animate-spin">{children}</Loader2Icon>
)
