#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum { MAX_CHILDREN = 8 };

static int reap_children(const pid_t *children, size_t count) {
  int status = 0;
  for (size_t index = 0; index < count; index += 1) {
    if (waitpid(children[index], &status, 0) < 0) return 2;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 3;
  }
  return 0;
}

static int fork_probe(int bounded) {
  pid_t children[MAX_CHILDREN];
  size_t count = 0;
  int saw_eagain = 0;
  for (size_t index = 0; index < MAX_CHILDREN; index += 1) {
    pid_t child = fork();
    if (child < 0) {
      if (errno == EAGAIN) {
        saw_eagain = 1;
        break;
      }
      perror("fork");
      return 4;
    }
    if (child == 0) _exit(0);
    children[count] = child;
    count += 1;
  }
  int reap_status = reap_children(children, count);
  if (reap_status != 0) return reap_status;
  if (!bounded) return count == MAX_CHILDREN && !saw_eagain ? 0 : 5;
  return saw_eagain && count <= 1 ? 0 : 6;
}

static int hold_fifo(const char *fifo_path, const char *ready_path) {
  int fifo = open(fifo_path, O_WRONLY);
  if (fifo < 0) {
    perror("open fifo");
    return 7;
  }
  int ready = open(ready_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (ready < 0) {
    perror("open ready marker");
    close(fifo);
    return 8;
  }
  const char marker[] = "payload-fd-ready\n";
  ssize_t written = write(ready, marker, sizeof(marker) - 1);
  close(ready);
  if (written != (ssize_t)(sizeof(marker) - 1)) {
    close(fifo);
    return 9;
  }
  for (;;) {
    struct timespec delay = {.tv_sec = 1, .tv_nsec = 0};
    if (nanosleep(&delay, NULL) < 0 && errno != EINTR) {
      close(fifo);
      return 10;
    }
  }
}

static void usage(const char *program) {
  fprintf(stderr, "usage: %s --probe-unbounded | --assert-nproc | --hold-fd FIFO READY\n", program);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe-unbounded") == 0) {
    return fork_probe(0);
  }
  if (argc == 2 && strcmp(argv[1], "--assert-nproc") == 0) {
    return fork_probe(1);
  }
  if (argc == 4 && strcmp(argv[1], "--hold-fd") == 0) {
    return hold_fifo(argv[2], argv[3]);
  }
  usage(argv[0]);
  return 64;
}
