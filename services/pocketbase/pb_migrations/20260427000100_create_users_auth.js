migrate(
  (app) => {
    const collection = new Collection({
      type: 'auth',
      name: 'users',
      listRule: 'id = @request.auth.id',
      viewRule: 'id = @request.auth.id',
      createRule: '',
      updateRule: 'id = @request.auth.id',
      deleteRule: null,
      fields: [
        {
          type: 'text',
          name: 'username',
          required: true,
          min: 3,
          max: 32,
          pattern: '^[a-z0-9_]+$',
          presentable: true,
        },
      ],
      indexes: ['CREATE UNIQUE INDEX idx_users_username ON users (username)'],
      passwordAuth: {
        enabled: true,
        identityFields: ['username'],
      },
      oauth2: {
        enabled: false,
      },
      otp: {
        enabled: false,
      },
      mfa: {
        enabled: false,
      },
    });

    app.save(collection);
  },
  (app) => {
    const collection = app.findCollectionByNameOrId('users');
    app.delete(collection);
  },
);
