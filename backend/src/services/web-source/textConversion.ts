import { Converter } from 'opencc-js'

const traditionalToSimplified = Converter({ from: 'tw', to: 'cn' })

export function toSimplifiedQuery(text: string): string {
  return traditionalToSimplified(text)
}
