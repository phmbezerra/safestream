// Package auth verifies room membership against the existing SafeStream Node API.
// It uses only stdlib so the authorization boundary can be tested independently.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var roomPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{12}$`)
var tokenPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{32}$`)

var ErrUnauthorized = errors.New("room access denied")

type Validator struct {
	BaseURL string
	Client  *http.Client
}

type roomResponse struct {
	RoomID string `json:"roomId"`
	Role   string `json:"role"`
}

func NewValidator(baseURL string) *Validator {
	return &Validator{BaseURL: strings.TrimRight(baseURL, "/"), Client: &http.Client{Timeout: 800 * time.Millisecond}}
}

// Check returns the SERVER-VERIFIED role, not an untrusted role from a browser.
func (v *Validator) Check(ctx context.Context, roomID, bearer string) (string, error) {
	if !roomPattern.MatchString(roomID) || !tokenPattern.MatchString(bearer) {
		return "", ErrUnauthorized
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.BaseURL+"/api/rooms/"+roomID, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	res, err := v.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("authorization API unavailable: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", ErrUnauthorized
	}
	var data roomResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&data); err != nil {
		return "", fmt.Errorf("invalid authorization response: %w", err)
	}
	if data.RoomID != roomID || (data.Role != "publisher" && data.Role != "viewer") {
		return "", ErrUnauthorized
	}
	return data.Role, nil
}
