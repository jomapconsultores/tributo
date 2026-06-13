import { credentialsAPI } from './api'

// Single in-flight request shared across all components.
// Returns Map<clientId, { username, password }>.
let _promise = null
let _cache = null

export function clearCredentialsCache() {
  _promise = null
  _cache = null
}

export function getRevealedCredentials() {
  if (_cache) return Promise.resolve(_cache)
  if (_promise) return _promise
  _promise = credentialsAPI.revealAll()
    .then((r) => {
      const map = new Map()
      for (const item of (r.data?.data || [])) {
        if (item.client_id) {
          map.set(item.client_id, {
            username: item.username || '',
            password: item.password || '',
          })
        }
      }
      _cache = map
      return map
    })
    .catch(() => {
      _promise = null
      return new Map()
    })
  return _promise
}
