package main

import "errors"

// Whitelist both directions: no provider response or credential reaches JS.
func (g *graphBrowser) activation(command string, payload map[string]any) (any, error) {
	request := map[string]any{}
	keys := []string{"account", "generation"}
	if command == "graph.activationBegin" {
		keys = []string{"attempt", "display_name"}
	} else if command != "graph.activationPoll" && command != "graph.activationCancel" {
		return nil, errors.New("Graph activation: unsupported command")
	}
	for _, key := range keys {
		value, _ := payload[key].(string)
		if key != "display_name" && value == "" {
			return nil, errors.New("Graph activation: missing field")
		}
		if len(value) > 512 {
			return nil, errors.New("Graph activation: invalid field")
		}
		request[key] = value
	}
	answer, err := g.call(command, request)
	if err != nil {
		return nil, err
	}
	var result struct {
		Account           string  `json:"account,omitempty"`
		Generation        string  `json:"generation,omitempty"`
		State             string  `json:"state,omitempty"`
		Pages             uint64  `json:"pages"`
		Changes           uint64  `json:"changes"`
		Error             *string `json:"error,omitempty"`
		RetryAfterSeconds *uint64 `json:"retry_after_seconds,omitempty"`
		MailBackendReady  bool    `json:"mail_backend_ready"`
		OK                bool    `json:"ok,omitempty"`
	}
	if graphDecode(answer, &result) != nil {
		return nil, errors.New("Graph activation: invalid response")
	}
	return result, nil
}
