export const meta = {
  name: 'two-words',
  description: 'Run two agents in parallel that each reply with one word',
  phases: [{title: 'Say'}],
}

const results = await parallel([
  () => agent('Reply with only the word: red', {label: 'one', phase: 'Say'}),
  () => agent('Reply with only the word: blue', {label: 'two', phase: 'Say'}),
])

return { results }
