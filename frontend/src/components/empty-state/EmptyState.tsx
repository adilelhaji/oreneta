import { AtSign } from 'lucide-react'
import { StateFrame } from './StateViews'

export function EmptyState({ title, text }: { title: string; text: string }) {
  return <StateFrame icon={AtSign} title={title} text={text} />
}
