const CACHE_PREFIX = 'zzcblog-v1'
const PRECACHE_URLS = ['/']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_PREFIX).then(cache => cache.addAll(PRECACHE_URLS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_PREFIX).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  // 只缓存 GET 请求
  if (event.request.method !== 'GET') return

  // 跳过 CDN 图片等外部资源，避免缓存过大
  const url = new URL(event.request.url)
  if (url.hostname !== location.hostname) return

  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_PREFIX).then(cache => cache.put(event.request, clone))
        }
        return response
      })
      return cached || fetchPromise
    })
  )
})