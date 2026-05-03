package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		privacySettings, err := app.FindCollectionByNameOrId("privacy_settings")
		if err != nil {
			return err
		}

		ensureSelectField(privacySettings, "presence_visibility", []string{"everybody", "contacts_and_shared_chats", "nobody"}, true)
		if err := app.Save(privacySettings); err != nil {
			return err
		}
		if _, err := app.DB().NewQuery("UPDATE privacy_settings SET presence_visibility = 'contacts_and_shared_chats' WHERE presence_visibility = ''").Execute(); err != nil {
			return err
		}

		if err := ensurePresenceSessionsCollection(app, users); err != nil {
			return err
		}

		return ensurePresenceExposuresCollection(app, users)
	}, func(app core.App) error {
		for _, name := range []string{"presence_exposures", "presence_sessions"} {
			if err := dropCollectionIfExists(app, name); err != nil {
				return err
			}
		}

		privacySettings, err := app.FindCollectionByNameOrId("privacy_settings")
		if err != nil {
			return err
		}
		privacySettings.Fields.RemoveByName("presence_visibility")

		return app.Save(privacySettings)
	})
}

func ensurePresenceSessionsCollection(app core.App, users *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("presence_sessions")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection = core.NewBaseCollection("presence_sessions")
	}

	collection.ListRule = pointer("@request.auth.id != '' && user = @request.auth.id")
	collection.ViewRule = pointer("@request.auth.id != '' && user = @request.auth.id")
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	ensureRelationField(collection, "user", users.Id, true, true)
	ensureTextField(collection, "device_id", 160, true)
	ensureDateField(collection, "last_seen_at")
	ensureDateField(collection, "ended_at")
	ensureAutodateFields(collection)
	collection.Indexes = removeIndex(collection.Indexes, "idx_presence_sessions_user_device")
	collection.Indexes = removeIndex(collection.Indexes, "idx_presence_sessions_user_last_seen")
	collection.AddIndex("idx_presence_sessions_user_device", true, "user, device_id", "")
	collection.AddIndex("idx_presence_sessions_user_last_seen", false, "user, last_seen_at, ended_at", "")

	return app.Save(collection)
}

func ensurePresenceExposuresCollection(app core.App, users *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("presence_exposures")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection = core.NewBaseCollection("presence_exposures")
	}

	collection.ListRule = pointer("@request.auth.id != '' && (viewer = @request.auth.id || subject = @request.auth.id)")
	collection.ViewRule = pointer("@request.auth.id != '' && (viewer = @request.auth.id || subject = @request.auth.id)")
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	ensureRelationField(collection, "viewer", users.Id, true, true)
	ensureRelationField(collection, "subject", users.Id, true, true)
	ensureDateField(collection, "expires_at")
	ensureAutodateFields(collection)
	collection.Indexes = removeIndex(collection.Indexes, "idx_presence_exposures_pair")
	collection.Indexes = removeIndex(collection.Indexes, "idx_presence_exposures_expires")
	collection.AddIndex("idx_presence_exposures_pair", true, "viewer, subject", "")
	collection.AddIndex("idx_presence_exposures_expires", false, "expires_at", "")

	return app.Save(collection)
}
