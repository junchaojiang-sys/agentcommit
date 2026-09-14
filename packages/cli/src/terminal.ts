import { createInterface } from 'node:readline/promises'

export interface ConfirmationUI {
  interactive: boolean
  ask(question: string): Promise<string>
  write(text: string): void
}

export const terminal: ConfirmationUI = {
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  write: (text) => { process.stdout.write(text + '\n') },
  async ask(question) {
    if (!this.interactive) return ''
    const reader = createInterface({ input: process.stdin, output: process.stdout })
    try { return await reader.question(question) } finally { reader.close() }
  },
}
