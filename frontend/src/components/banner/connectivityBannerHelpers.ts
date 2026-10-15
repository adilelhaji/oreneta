type AccountLabelSource = {
  id: string
  email: string
  display_name: string
}

export function connectivityAccountLabel(accountId: string | null, accounts: AccountLabelSource[]): string | null {
  if (!accountId) return null

  const account = accounts.find((candidate) => candidate.id === accountId)
  if (!account) return accountId

  const displayName = account.display_name.trim()
  const email = account.email.trim()
  if (!displayName) return email || account.id

  const duplicateName = accounts.some(
    (candidate) =>
      candidate.id !== account.id &&
      candidate.display_name.trim().localeCompare(displayName, undefined, { sensitivity: 'accent' }) === 0,
  )
  return duplicateName && email && email.localeCompare(displayName, undefined, { sensitivity: 'accent' }) !== 0
    ? `${displayName} (${email})`
    : displayName
}
