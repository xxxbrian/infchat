package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		conversations, err := app.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}
		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		if err := ensureConversationUserStatesCollection(app, users, conversations); err != nil {
			return err
		}
		if err := ensureSyncCursorsCollection(app); err != nil {
			return err
		}
		if err := ensureSyncEventsCollection(app, users, conversations); err != nil {
			return err
		}
		if err := ensureIdempotencyKeysCollection(app, users, conversations, messages); err != nil {
			return err
		}

		return ensurePushOutboxCollection(app, users, conversations)
	}, func(app core.App) error {
		return nil
	})
}
