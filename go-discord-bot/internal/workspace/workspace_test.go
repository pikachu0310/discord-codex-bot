package workspace

import "testing"

func TestParseRepository(t *testing.T) {
	repo, err := ParseRepository("owner/repo-name")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if repo.FullName != "owner/repo-name" {
		t.Fatalf("fullname = %s", repo.FullName)
	}
}

func TestParseRepositoryInvalid(t *testing.T) {
	if _, err := ParseRepository("invalid"); err == nil {
		t.Fatal("expected parse error")
	}
}
