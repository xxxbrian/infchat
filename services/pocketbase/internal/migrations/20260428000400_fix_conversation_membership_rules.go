package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		conversations, err := app.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}

		conversations.ListRule = pointer("members.id ?= @request.auth.id")
		conversations.ViewRule = pointer("members.id ?= @request.auth.id")

		if err := app.Save(conversations); err != nil {
			return err
		}

		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		messages.ListRule = pointer("conversation.members.id ?= @request.auth.id")
		messages.ViewRule = pointer("conversation.members.id ?= @request.auth.id")

		return app.Save(messages)
	}, func(app core.App) error {
		conversations, err := app.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}

		conversations.ListRule = pointer("members ?= @request.auth.id")
		conversations.ViewRule = pointer("members ?= @request.auth.id")

		if err := app.Save(conversations); err != nil {
			return err
		}

		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		messages.ListRule = pointer("conversation.members ?= @request.auth.id")
		messages.ViewRule = pointer("conversation.members ?= @request.auth.id")

		return app.Save(messages)
	})
}
