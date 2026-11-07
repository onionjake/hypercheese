'use strict';
const value = { session: { server: 'https://example.invalid', token: 't' }, user: { id: 1, can_write: true } };
module.exports = { __esModule: true, useAuth: () => value };
