onRecordCreateRequest((event) => {
  const username = String(event.record.get('username') || '')
    .trim()
    .toLowerCase();

  event.record.set('username', username);
  return event.next();
}, 'users');

onRecordUpdateRequest((event) => {
  const username = String(event.record.get('username') || '')
    .trim()
    .toLowerCase();

  event.record.set('username', username);
  return event.next();
}, 'users');
