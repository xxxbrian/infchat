migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId('users');

    collection.listRule = 'id = @request.auth.id';
    collection.viewRule = 'id = @request.auth.id';
    collection.createRule = '';
    collection.updateRule = 'id = @request.auth.id';
    collection.deleteRule = null;

    const emailField = collection.fields.getByName('email');
    emailField.required = false;

    let usernameField = collection.fields.getByName('username');
    if (!usernameField) {
      usernameField = new TextField({ name: 'username' });
      collection.fields.add(usernameField);
    }

    usernameField.required = true;
    usernameField.min = 3;
    usernameField.max = 32;
    usernameField.pattern = '^[a-z0-9_]+$';
    usernameField.presentable = true;

    collection.passwordAuth.enabled = true;
    collection.passwordAuth.identityFields = ['username'];
    collection.oauth2.enabled = false;
    collection.otp.enabled = false;
    collection.mfa.enabled = false;

    collection.indexes = collection.indexes.filter(
      (index) => !index.includes('idx_users_username'),
    );
    collection.addIndex('idx_users_username', true, 'username', '');

    app.save(collection);
  },
  (app) => {
    const collection = app.findCollectionByNameOrId('users');

    const emailField = collection.fields.getByName('email');
    emailField.required = true;

    collection.passwordAuth.identityFields = ['email'];
    collection.indexes = collection.indexes.filter(
      (index) => !index.includes('idx_users_username'),
    );

    app.save(collection);
  },
);
