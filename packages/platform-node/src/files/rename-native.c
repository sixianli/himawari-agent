#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#if defined(__linux__)
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif
#endif

/* Fixed operation only; no shell, copying, overwriting, or cross-device fallback.
 * Open every parent relative to the already verified root without following links.
 * The caller owns the shared admission; external writers are not a filesystem CAS. */
static int fail(const char *code) { fprintf(stderr, "%s\n", code); return 1; }
static int parent(int root, const char *relative, char **storage, char **name, dev_t device) {
  *storage = strdup(relative);
  if (!*storage || !**storage || **storage == '/') return -1;
  int fd = dup(root);
  if (fd < 0) return -1;
  char *part = *storage;
  for (;;) {
    char *slash = strchr(part, '/');
    if (slash) *slash = 0;
    if (!*part || !strcmp(part, ".") || !strcmp(part, "..")) { close(fd); return -1; }
    if (!slash) { *name = part; return fd; }
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(fd);
    if (next < 0) return -1;
    struct stat info;
    if (fstat(next, &info) || info.st_dev != device) { close(next); return -1; }
    fd = next;
    part = slash + 1;
  }
}
static int number(const char *text, uintmax_t *result) {
  char *end = NULL;
  errno = 0;
  *result = strtoull(text, &end, 10);
  return !errno && end != text && !*end && *text != '-';
}
int main(int argc, char **argv) {
  if (argc != 8) return fail("HOST_DIRECTORY_RENAME_INPUT_INVALID");
  uintmax_t rootDev, rootIno, sourceDev, sourceIno;
  if (!number(argv[4], &rootDev) || !number(argv[5], &rootIno) ||
      !number(argv[6], &sourceDev) || !number(argv[7], &sourceIno))
    return fail("HOST_DIRECTORY_RENAME_INPUT_INVALID");
  int root = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat rootInfo, source, destination;
  if (root < 0 || fstat(root, &rootInfo) ||
      (uintmax_t)rootInfo.st_dev != rootDev || (uintmax_t)rootInfo.st_ino != rootIno)
    return fail("HOST_ROOT_IDENTITY_CHANGED");
  char *left = NULL, *right = NULL, *from = NULL, *to = NULL;
  int sourceParent = parent(root, argv[2], &left, &from, rootInfo.st_dev);
  int targetParent = parent(root, argv[3], &right, &to, rootInfo.st_dev);
  if (sourceParent < 0 || targetParent < 0) return fail("HOST_PATH_PARENT_CHANGED");
  if (fstatat(sourceParent, from, &source, AT_SYMLINK_NOFOLLOW) ||
      !S_ISDIR(source.st_mode) || (uintmax_t)source.st_dev != sourceDev ||
      (uintmax_t)source.st_ino != sourceIno || source.st_dev != rootInfo.st_dev)
    return fail("HOST_DIRECTORY_IDENTITY_CHANGED");
  if (!fstatat(targetParent, to, &destination, AT_SYMLINK_NOFOLLOW) || errno != ENOENT)
    return fail("HOST_FILE_TARGET_EXISTS");
  int result;
#if defined(__APPLE__)
  result = renameatx_np(sourceParent, from, targetParent, to, RENAME_EXCL);
#elif defined(__linux__)
  result = syscall(SYS_renameat2, sourceParent, from, targetParent, to, RENAME_NOREPLACE);
#else
  return fail("HOST_DIRECTORY_RENAME_UNSUPPORTED");
#endif
  if (result) return fail(errno == EEXIST || errno == ENOTEMPTY ? "HOST_FILE_TARGET_EXISTS" :
                         errno == EXDEV ? "HOST_DIRECTORY_CROSS_DEVICE" : "HOST_DIRECTORY_RENAME_FAILED");
  /* No success before directory entries are durable. On failure, recovery must
   * inspect the original source inode at the destination, never repeat blindly. */
  if (fsync(sourceParent) || fsync(targetParent)) return fail("HOST_DIRECTORY_DURABILITY_UNKNOWN");
  if (fstatat(targetParent, to, &destination, AT_SYMLINK_NOFOLLOW) ||
      destination.st_dev != source.st_dev || destination.st_ino != source.st_ino)
    return fail("HOST_DIRECTORY_RESULT_UNKNOWN");
  close(sourceParent); close(targetParent); close(root); free(left); free(right);
  return 0;
}
