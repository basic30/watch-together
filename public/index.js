const createBtn = document.getElementById('createBtn')
const createResult = document.getElementById('createResult')
const joinId = document.getElementById('joinId')
const joinBtn = document.getElementById('joinBtn')

createBtn.addEventListener('click', async () => {
  createBtn.disabled = true
  createResult.textContent = 'Creating...'
  try {
    const res = await fetch('/api/rooms/create', { method: 'POST' })
    const data = await res.json()
    if (data && data.id) {
      window.location.href = `/room.html?id=${encodeURIComponent(data.id)}`
    } else {
      createResult.textContent = 'Failed to create room'
      createBtn.disabled = false
    }
  } catch {
    createResult.textContent = 'Error creating room'
    createBtn.disabled = false
  }
})

joinBtn.addEventListener('click', () => {
  const id = (joinId.value || '').trim()
  if (!id) return
  window.location.href = `/room.html?id=${encodeURIComponent(id)}`
})
