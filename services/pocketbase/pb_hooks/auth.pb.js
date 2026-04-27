function normalizeUsername(record) {
  const username = String(record.get('username') || '')
    .trim()
    .toLowerCase();

  record.set('username', username);
}

onRecordCreateRequest((event) => {
  normalizeUsername(event.record);
  return event.next();
}, 'users');

onRecordUpdateRequest((event) => {
  normalizeUsername(event.record);
  return event.next();
}, 'users');
