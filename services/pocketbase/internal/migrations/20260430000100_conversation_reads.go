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

		conversations, err := app.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}

		conversationReads := core.NewBaseCollection("conversation_reads")
		conversationReads.ListRule = pointer("conversation.members.id ?= @request.auth.id")
		conversationReads.ViewRule = pointer("conversation.members.id ?= @request.auth.id")
		conversationReads.CreateRule = pointer("@request.auth.id != ''")
		conversationReads.UpdateRule = pointer("@request.auth.id != '' && user.id = @request.auth.id")
		conversationReads.DeleteRule = nil
		conversationReads.Fields.Add(
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.DateField{Name: "last_read_at", Required: true},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		conversationReads.AddIndex("idx_conversation_reads_unique_user", true, "conversation, user", "")
		conversationReads.AddIndex("idx_conversation_reads_conversation", false, "conversation", "")

		return app.Save(conversationReads)
	}, func(app core.App) error {
		conversationReads, err := app.FindCollectionByNameOrId("conversation_reads")
		if err == nil {
			return app.Delete(conversationReads)
		}

		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}

		return err
	})
}
