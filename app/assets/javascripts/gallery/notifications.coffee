# Web Push notifications: subscribe this browser to bullhorn notifications.
# Only offered when the server exposes a VAPID public key (see
# WebPushSender) and the browser supports push.

webPushKey = ->
  document.querySelector('meta[name="vapid-public-key"]')?.content

webPushSupported = ->
  webPushKey()? && 'serviceWorker' of navigator && 'PushManager' of window && 'Notification' of window

urlBase64ToUint8Array = (base64String) ->
  padding = '='.repeat (4 - base64String.length % 4) % 4
  base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  raw = window.atob base64
  output = new Uint8Array raw.length
  for i in [0...raw.length]
    output[i] = raw.charCodeAt i
  output

component 'NotificationsMenuItem', ->
  # 'unknown' until the subscription state has been checked
  [state, setState] = React.useState 'unknown'

  useEffect ->
    return unless webPushSupported()
    navigator.serviceWorker.getRegistration().then (reg) ->
      unless reg
        setState 'off'
        return
      reg.pushManager.getSubscription().then (sub) ->
        setState if sub then 'on' else 'off'
    undefined
  , []

  enable = ->
    try
      reg = await navigator.serviceWorker.register '/service-worker.js'
      permission = await Notification.requestPermission()
      return unless permission == 'granted'
      sub = await reg.pushManager.subscribe
        userVisibleOnly: true
        applicationServerKey: urlBase64ToUint8Array webPushKey()
      Store.jax
        url: '/web_push_subscriptions'
        method: 'POST'
        contentType: 'application/json'
        data: JSON.stringify sub.toJSON()
        success: -> setState 'on'
    catch err
      console.warn 'Could not enable notifications', err
      alert 'Could not enable notifications'

  disable = ->
    reg = await navigator.serviceWorker.getRegistration()
    sub = await reg?.pushManager.getSubscription()
    unless sub
      setState 'off'
      return
    endpoint = sub.endpoint
    await sub.unsubscribe()
    Store.jax
      url: '/web_push_subscriptions'
      method: 'DELETE'
      contentType: 'application/json'
      data: JSON.stringify endpoint: endpoint
      success: -> setState 'off'

  onClick = (e) ->
    e.preventDefault()
    if state == 'on' then disable() else enable()

  return null unless webPushSupported()
  return null if state == 'unknown'

  <li>
    <a className="dropdown-item" href="#" onClick={onClick}>
      {if state == 'on' then 'Disable notifications' else 'Enable notifications'}
    </a>
  </li>
