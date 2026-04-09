package workspace

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var repoPattern = regexp.MustCompile(`^([a-zA-Z0-9_-]+)/([a-zA-Z0-9_.-]+)$`)

type Repository struct {
	Owner    string
	Name     string
	FullName string
}

type Manager struct {
	baseDir string
}

func New(baseDir string) *Manager {
	return &Manager{baseDir: baseDir}
}

func (m *Manager) Init() error {
	dirs := []string{
		filepath.Join(m.baseDir, "repositories"),
		filepath.Join(m.baseDir, "workspaces", "chat"),
		filepath.Join(m.baseDir, "workspaces", "repo"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func ParseRepository(spec string) (Repository, error) {
	match := repoPattern.FindStringSubmatch(strings.TrimSpace(spec))
	if len(match) != 3 {
		return Repository{}, errors.New("repository must be owner/repo")
	}
	owner := match[1]
	name := match[2]
	return Repository{
		Owner:    owner,
		Name:     name,
		FullName: owner + "/" + name,
	}, nil
}

func (m *Manager) EnsureChatWorkspace(threadID string) (string, error) {
	path := filepath.Join(m.baseDir, "workspaces", "chat", threadID)
	if err := os.MkdirAll(path, 0o755); err != nil {
		return "", err
	}
	return path, nil
}

func (m *Manager) EnsureRepositoryCache(repo Repository) (string, bool, error) {
	path := filepath.Join(m.baseDir, "repositories", repo.Owner, repo.Name)
	if _, err := os.Stat(path); err == nil {
		if err := updateRepository(path); err != nil {
			return "", false, err
		}
		return path, false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", false, err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", false, err
	}

	url := fmt.Sprintf("https://github.com/%s.git", repo.FullName)
	cmd := exec.Command("git", "clone", url, path)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", false, fmt.Errorf("git clone failed: %w: %s", err, string(out))
	}
	return path, true, nil
}

func (m *Manager) EnsureRepoWorkspace(threadID, cachePath string) (string, error) {
	path := filepath.Join(m.baseDir, "workspaces", "repo", threadID)
	if _, err := os.Stat(path); err == nil {
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	if err := copyDir(cachePath, path); err != nil {
		return "", err
	}

	branch := fmt.Sprintf("bot/%s-%s", time.Now().Format("20060102-150405"), sanitize(threadID))
	_ = runGit(path, "checkout", "-b", branch)
	return path, nil
}

func updateRepository(path string) error {
	if err := runGit(path, "fetch", "origin"); err != nil {
		return err
	}
	branch, err := defaultBranch(path)
	if err != nil {
		branch = "main"
	}
	_ = runGit(path, "checkout", branch)
	_ = runGit(path, "pull", "--ff-only", "origin", branch)
	return nil
}

func defaultBranch(path string) (string, error) {
	cmd := exec.Command("git", "-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", err
	}
	branch := strings.TrimSpace(string(out))
	branch = strings.TrimPrefix(branch, "origin/")
	if branch == "" {
		return "", errors.New("empty default branch")
	}
	return branch, nil
}

func runGit(path string, args ...string) error {
	cmd := exec.Command("git", append([]string{"-C", path}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git %s failed: %w: %s", strings.Join(args, " "), err, string(out))
	}
	return nil
}

func copyDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}

		if d.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		if d.Type()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}

	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return nil
}

func sanitize(v string) string {
	v = strings.ReplaceAll(v, "/", "_")
	v = strings.ReplaceAll(v, "\\", "_")
	return v
}
