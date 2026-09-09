package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGraphActivationBridgeWhitelistsBothDirections(t *testing.T) {
	for _, command := range []string{"graph.activationBegin", "graph.activationPoll", "graph.activationCancel"} {
		g := &graphBrowser{call: func(method string, p map[string]any) (any, error) {
			if method != command {
				t.Fatal(method)
			}
			if _, ok := p["access_token"]; ok {
				t.Fatal("forwarded credential")
			}
			if len(p) != 2 {
				t.Fatal(p)
			}
			return map[string]any{"account": "a", "generation": "g", "state": "syncing", "pages": 3, "access_token": "DO-NOT-EXPOSE", "checkpoint": "SECRET"}, nil
		}}
		result, err := g.activation(command, map[string]any{"account": "a", "generation": "g", "attempt": "attempt", "display_name": "Reader", "access_token": "secret"})
		if err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(result)
		if strings.Contains(string(data), "SECRET") || strings.Contains(string(data), "DO-NOT") || strings.Contains(string(data), "token") {
			t.Fatal(string(data))
		}
	}
}

func TestGraphActivationRejectsUnknownAndMissingFields(t *testing.T) {
	g := &graphBrowser{call: func(string, map[string]any) (any, error) { t.Fatal("must not call backend"); return nil, nil }}
	for _, command := range []string{"send", "graph.activationBegin", "graph.activationPoll", "graph.activationCancel"} {
		if _, err := g.activation(command, map[string]any{}); err == nil {
			t.Fatal(command)
		}
	}
}

func TestGraphFolderParentAndDisplayNameAreIndependent(t *testing.T) {
	result := foldersJSON("a", map[string]any{"folders": []any{map[string]any{"name": "graph.opaque", "display_name": "Same name", "parent_id": "INBOX"}, map[string]any{"name": "INBOX", "display_name": "Inbox", "parent_id": ""}, map[string]any{"name": "Legacy"}}}).(map[string]any)["folders"].([]Folder)
	if result[0].ID != "graph.opaque" || result[0].Name != "Same name" || result[0].ParentID == nil || *result[0].ParentID != "INBOX" {
		t.Fatal(result[0])
	}
	if result[1].ParentID == nil || *result[1].ParentID != "" || result[2].ParentID != nil {
		t.Fatal(result)
	}
}
