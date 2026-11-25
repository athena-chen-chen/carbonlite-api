/* Metadata-only Linux x86_64 descendant observer. No argv/env/payload logging.
 * Linux runtime capability tests are mandatory; portability build is not proof.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if defined(__linux__) || defined(CL_SYNTAX_ONLY) || defined(CL_ROOT_SELFTEST)
struct root_result {
  pid_t pid;
  unsigned long long start;
  int latched, code;
};
static int latch_root(struct root_result *r, pid_t pid,
                      unsigned long long start, int original, int code) {
  if (!original)
    return 0;
  if (r->latched || pid != r->pid || !start || start != r->start)
    return -1;
  r->code = code;
  r->latched = 1;
  return 1;
}
static int final_code(const struct root_result *r, int complete) {
  return complete && r->latched ? r->code : 125;
}
#endif

#if defined(CL_ROOT_SELFTEST)
int main(void) {
  struct root_result r = {123, 10, 0, 125};
  if (latch_root(&r, 123, 10, 1, 7) != 1 || final_code(&r, 1) != 7)
    return 1;
  if (latch_root(&r, 123, 11, 0, 0) != 0 || final_code(&r, 1) != 7)
    return 2;
  if (latch_root(&r, 123, 11, 1, 0) != -1 || final_code(&r, 1) != 7)
    return 3;
  if (latch_root(&r, 123, 10, 1, 0) != -1 || final_code(&r, 0) != 125)
    return 4;
  r = (struct root_result){123, 10, 0, 125};
  if (latch_root(&r, 123, 10, 1, 0) != 1 || final_code(&r, 1) != 0 ||
      final_code(&r, 0) != 125)
    return 5;
  puts("ROOT_IDENTITY_SELFTEST: PASS");
  return 0;
}
#elif defined(__linux__) || defined(CL_SYNTAX_ONLY)
/* Stable Linux UAPI constants, deliberately separated from host ptrace headers.
 * CL_SYNTAX_ONLY permits a host compiler to typecheck this branch, never
 * execute it.
 */
extern long ptrace(int, ...);
extern int prctl(int, ...);
extern ssize_t process_vm_readv(pid_t, const struct iovec *, unsigned long,
                                const struct iovec *, unsigned long,
                                unsigned long);
enum {
  PT_TRACEME = 0,
  PT_PEEKDATA = 2,
  PT_GETEVENTMSG = 0x4201,
  PT_SETOPTIONS = 0x4200,
  PT_SYSCALL = 24,
  PT_GETINFO = 0x420e
};
enum { EV_FORK = 1, EV_VFORK = 2, EV_CLONE = 3, EV_EXEC = 4, EV_EXIT = 6 };
enum { OPTS = 1 | 2 | 4 | 8 | 16 | 64 | 0x100000, WALL = 0x40000000 };
struct syscall_info {
  uint8_t op, pad[3];
  uint32_t arch;
  uint64_t ip, sp;
  union {
    struct {
      uint64_t nr, args[6];
    } entry;
    struct {
      int64_t value;
      uint8_t error;
    } exit;
  } u;
};
struct task {
  pid_t tid;
  int registered, stopped, first, original_root;
  unsigned long long start;
};
static struct task tasks[256];
static size_t events, bytes;
static unsigned limit_seconds = 180;
static int trace_error, integrity_lost;
static unsigned reaped_tasks;
static struct root_result root_result;
static pid_t root_pid;
static pid_t driver_pid;
static unsigned long long driver_start;
static unsigned long long observer_start;
static const char *stage;
static volatile sig_atomic_t interrupted;
static int live(void);

static void on_signal(int sig) {
  (void)sig;
  interrupted = 1;
}
static unsigned long long ns(clockid_t clk) {
  struct timespec t;
  if (clock_gettime(clk, &t))
    return 0;
  return (unsigned long long)t.tv_sec * 1000000000ULL +
         (unsigned long long)t.tv_nsec;
}
static struct task *slot(pid_t tid, int create) {
  for (size_t i = 0; i < 256; i++)
    if (tasks[i].tid == tid)
      return &tasks[i];
  if (create)
    for (size_t i = 0; i < 256; i++)
      if (!tasks[i].tid) {
        tasks[i] = (struct task){.tid = tid, .first = 1};
        return &tasks[i];
      }
  return NULL;
}
/* Read starttime only; never output comm or the complete proc record. */
static unsigned long long process_identity(pid_t pid, char *state) {
  char path[64], buf[4096];
  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  FILE *f = fopen(path, "r");
  if (!f)
    return 0;
  size_t n = fread(buf, 1, sizeof(buf) - 1, f);
  int bad = ferror(f);
  fclose(f);
  if (bad || !n || n == sizeof(buf) - 1)
    return 0;
  buf[n] = 0;
  char *p = strrchr(buf, ')');
  if (!p || p[1] != ' ')
    return 0;
  p += 2;
  if (state)
    *state = *p;
  char *save = NULL, *word = strtok_r(p, " ", &save);
  for (int field = 3; word; field++, word = strtok_r(NULL, " ", &save))
    if (field == 22) {
      char *end;
      errno = 0;
      unsigned long long value = strtoull(word, &end, 10);
      return !errno && end != word && !*end ? value : 0;
    }
  return 0;
}
static unsigned long long birth(pid_t pid) {
  return process_identity(pid, NULL);
}
static int driver_alive(void) {
  char state = 0;
  return process_identity(driver_pid, &state) == driver_start && state != 'Z' &&
         state != 'X';
}
static int lifecycle(const char *kind, int complete, int cleaned) {
  int n;
  if (!strcmp(kind, "observer")) {
    n = printf(
        "{\"kind\":\"observer\",\"stage\":\"%s\",\"uid\":24001,\"pid\":%d,"
        "\"start_ticks\":%llu,\"driver_pid\":%d,\"driver_start_ticks\":%llu}\n",
        stage, getpid(), observer_start, driver_pid, driver_start);
  } else {
    n = printf(
        "{\"kind\":\"completion\",\"stage\":\"%s\",\"uid\":24001,\"pid\":%d,"
        "\"start_ticks\":%llu,\"driver_pid\":%d,\"driver_start_ticks\":%llu,"
        "\"root_pid\":%d,\"root_start_ticks\":%llu,\"root_exit_code\":%d,"
        "\"root_latched\":%s,\"trace_complete\":%s,\"cleanup_complete\":%s,"
        "\"remaining_tasks\":%d,\"reaped_tasks\":%u}\n",
        stage, getpid(), observer_start, driver_pid, driver_start,
        root_result.pid, root_result.start, root_result.code,
        root_result.latched ? "true" : "false", complete ? "true" : "false",
        cleaned ? "true" : "false", live(), reaped_tasks);
  }
  if (n < 0 || fflush(stdout))
    return -1;
  bytes += (size_t)n;
  return bytes <= 512 * 1024 ? 0 : -1;
}
static int proc_info(pid_t tid, pid_t *tgid, pid_t *ppid, unsigned *uid) {
  char path[64], line[4096];
  snprintf(path, sizeof(path), "/proc/%d/status", tid);
  FILE *f = fopen(path, "r");
  if (!f)
    return -1;
  int got = 0;
  unsigned a, b, c, d;
  while (fgets(line, sizeof(line), f)) {
    if (sscanf(line, "Tgid: %d", tgid) == 1)
      got |= 1;
    if (sscanf(line, "PPid: %d", ppid) == 1)
      got |= 2;
    if (sscanf(line, "Uid: %u %u %u %u", &a, &b, &c, &d) == 4) {
      if (a != 24001 || b != a || c != a || d != a) {
        fclose(f);
        return -1;
      }
      *uid = a;
      got |= 4;
    }
  }
  int bad = ferror(f);
  fclose(f);
  return !bad && got == 7 ? 0 : -1;
}
static int unprivileged(void) {
  FILE *f = fopen("/proc/self/status", "r");
  if (!f)
    return 0;
  char line[512];
  int found = 0;
  unsigned long long cap;
  while (fgets(line, sizeof(line), f)) {
    if (sscanf(line, "CapEff: %llx", &cap) == 1 ||
        sscanf(line, "CapPrm: %llx", &cap) == 1 ||
        sscanf(line, "CapAmb: %llx", &cap) == 1) {
      if (cap) {
        fclose(f);
        return 0;
      }
      found++;
    }
  }
  int bad = ferror(f);
  fclose(f);
  return !bad && found == 3;
}
static int emit(pid_t tid, const char *kind, const char *ip, unsigned port,
                unsigned family, unsigned long long fd) {
  pid_t tgid = 0, ppid = 0;
  unsigned uid = 0;
  struct stat st;
  if (proc_info(tid, &tgid, &ppid, &uid))
    return -1;
  unsigned long long start = birth(tgid), parent_start = birth(ppid);
  struct task *parent = slot(ppid, 0);
  if (!((ppid == getpid() && parent_start == observer_start) ||
        (parent && parent->registered && parent->start &&
         parent_start == parent->start)))
    parent_start = 0;
  char path[64];
  snprintf(path, sizeof(path), "/proc/%d/exe", tid);
  if (!start || stat(path, &st) || !S_ISREG(st.st_mode))
    return -1;
  struct task *t = slot(tid, 0);
  if (!t)
    return -1;
  unsigned long long thread_start = birth(tid);
  if (!thread_start || (t->start && t->start != thread_start))
    return -1;
  t->start = thread_start;
  char out[1024];
  int n = snprintf(
      out, sizeof(out),
      "{\"kind\":\"%s\",\"stage\":\"%s\",\"utc_ns\":%llu,\"monotonic_ns\":%llu,"
      "\"uid\":%u,\"pid\":%d,\"tid\":%d,\"start_ticks\":%llu,\"ppid\":%d,"
      "\"parent_start_ticks\":%llu,\"parent_verified\":%s,\"exe_dev\":%llu,"
      "\"exe_ino\":%llu,\"destination\":\"%s\",\"port\":%u,\"socket_family\":%"
      "u,\"socket_fd\":%llu}\n",
      kind, stage, ns(CLOCK_REALTIME), ns(CLOCK_MONOTONIC), uid, tgid, tid,
      start, ppid, parent_start, parent_start ? "true" : "false",
      (unsigned long long)st.st_dev, (unsigned long long)st.st_ino, ip, port,
      family, fd);
  if (n < 1 || (size_t)n >= sizeof(out) || ++events > 2048 ||
      bytes + (size_t)n > 510 * 1024)
    return -1;
  bytes += (size_t)n;
  if (fwrite(out, 1, (size_t)n, stdout) != (size_t)n || fflush(stdout))
    return -1;
  return 0;
}
static int memory(pid_t tid, uint64_t address, void *dst, size_t n) {
  struct iovec l = {dst, n}, r = {(void *)(uintptr_t)address, n};
  return process_vm_readv(tid, &l, 1, &r, 1, 0) == (ssize_t)n ? 0 : -1;
}
static int connect_entry(pid_t tid, const struct syscall_info *s) {
  uint16_t family;
  uint64_t address = s->u.entry.args[1], length = s->u.entry.args[2];
  if (length < sizeof(family) || memory(tid, address, &family, sizeof(family)))
    return -1;
  char ip[INET6_ADDRSTRLEN];
  unsigned port;
  if (family == AF_INET) {
    struct sockaddr_in a;
    if (length < sizeof(a) || memory(tid, address, &a, sizeof(a)))
      return -1;
    if (a.sin_family != family)
      return -1;
    if (!inet_ntop(AF_INET, &a.sin_addr, ip, sizeof(ip)))
      return -1;
    port = ntohs(a.sin_port);
  } else if (family == AF_INET6) {
    struct sockaddr_in6 a;
    if (length < sizeof(a) || memory(tid, address, &a, sizeof(a)))
      return -1;
    if (a.sin6_family != family)
      return -1;
    if (!inet_ntop(AF_INET6, &a.sin6_addr, ip, sizeof(ip)))
      return -1;
    port = ntohs(a.sin6_port);
  } else
    return 0; /* Never read AF_UNIX names or any payload. */
  return emit(tid, "connect", ip, port, family, s->u.entry.args[0]);
}
static int resume(struct task *t, int sig) {
  if (ptrace(PT_SYSCALL, t->tid, 0, (long)sig) < 0)
    return -1;
  t->stopped = 0;
  return 0;
}
static int live(void) {
  int n = 0;
  for (size_t i = 0; i < 256; i++)
    if (tasks[i].tid)
      n++;
  return n;
}
static int cleanup(void) {
  /* Only outstanding traced tasks: ptrace stops/EXITKILL prevent PID reuse. */
  for (size_t i = 0; i < 256; i++)
    if (tasks[i].tid)
      kill(tasks[i].tid, SIGKILL);
  unsigned long long end = ns(CLOCK_MONOTONIC) + 5000000000ULL;
  /* Drain the kernel wait set too: a fork event may have created an attached
   * child before its task slot was registered when cancellation arrived. */
  while (ns(CLOCK_MONOTONIC) < end) {
    int status;
    pid_t p = waitpid(-1, &status, WALL | WNOHANG);
    if (p > 0) {
      struct task *t = slot(p, 0);
      if (WIFEXITED(status) || WIFSIGNALED(status)) {
        if (t) {
          memset(t, 0, sizeof(*t));
          reaped_tasks++;
        } else
          reaped_tasks++;
      } else {
        kill(p, SIGKILL);
        ptrace(PT_SYSCALL, p, 0, (long)SIGKILL);
      }
    } else if (p < 0) {
      if (errno == ECHILD)
        return !live() && !integrity_lost;
      if (errno != EINTR)
        return 0;
    } else
      usleep(1000);
  }
  return 0;
}
int main(int argc, char **argv) {
  struct utsname u;
  char tail;
  if (argc < 6 || strcmp(argv[2], "--driver") || strcmp(argv[4], "--") ||
      sscanf(argv[3], "%d:%llu%c", &driver_pid, &driver_start, &tail) != 2 ||
      driver_pid < 1 || driver_pid == getpid() || !driver_start ||
      getuid() != 24001 || geteuid() != 24001 || uname(&u) ||
      strcmp(u.sysname, "Linux") || strcmp(u.machine, "x86_64") ||
      !unprivileged())
    return 78;
  stage = argv[1];
  if (strcmp(stage, "capability") && strcmp(stage, "arm-A-migrate") &&
      strcmp(stage, "arm-B-migrate"))
    return 78;
  /* Fixed, validated driver argv is consumed but never emitted. */
  struct sigaction sa = {0};
  sa.sa_handler = on_signal;
  sigemptyset(&sa.sa_mask);
  if (sigaction(SIGTERM, &sa, NULL) || sigaction(SIGINT, &sa, NULL) ||
      sigaction(SIGHUP, &sa, NULL))
    return 78;
  observer_start = birth(getpid());
  pid_t parent_pid = getppid();
  if (!observer_start || !driver_alive() || prctl(1, SIGTERM, 0, 0, 0) ||
      getppid() != parent_pid || interrupted)
    return 78;
  if (lifecycle("observer", 0, 0))
    return 125;
  root_pid = fork();
  if (root_pid < 0)
    return 125;
  if (!root_pid) {
    int nullfd = open("/dev/null", O_RDWR);
    if (nullfd < 0)
      _exit(78);
    if (dup2(nullfd, 0) < 0 || dup2(nullfd, 1) < 0 || dup2(nullfd, 2) < 0)
      _exit(78);
    if (nullfd > 2)
      close(nullfd);
    if (setpgid(0, 0) || ptrace(PT_TRACEME, 0, 0, 0) < 0)
      _exit(78);
    raise(SIGSTOP);
    execvp(argv[5], &argv[5]);
    _exit(127);
  }
  struct task *root = slot(root_pid, 1);
  if (!root) {
    kill(root_pid, SIGKILL);
    return 125;
  }
  root->registered = 1;
  root->original_root = 1;
  root_result = (struct root_result){root_pid, 0, 0, 125};
  unsigned long long end =
      ns(CLOCK_MONOTONIC) + (unsigned long long)limit_seconds * 1000000000ULL;
  while (live() && !trace_error && !interrupted && driver_alive() &&
         ns(CLOCK_MONOTONIC) < end) {
    int status;
    pid_t p = waitpid(-1, &status, WALL | WNOHANG);
    if (p < 0) {
      if (errno == EINTR)
        continue;
      trace_error = 1;
      break;
    }
    if (!p) {
      usleep(1000);
      continue;
    }
    struct task *t = slot(p, 1);
    if (!t) {
      integrity_lost = 1;
      trace_error = 1;
      break;
    }
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
      if (!t->registered) {
        trace_error = 1;
        integrity_lost = 1;
        memset(t, 0, sizeof(*t));
        break;
      }
      int code =
          WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      if (latch_root(&root_result, p, t->start, t->original_root, code) < 0)
        trace_error = 1;
      reaped_tasks++;
      memset(t, 0, sizeof(*t));
      continue;
    }
    if (!WIFSTOPPED(status)) {
      trace_error = 1;
      break;
    }
    t->stopped = 1;
    if (!t->registered)
      continue; /* Wait for creator's fork event. */
    int sig = WSTOPSIG(status);
    unsigned event = (unsigned)status >> 16;
    if (t->first) {
      t->first = 0;
      t->start = birth(p);
      if (t->original_root)
        root_result.start = t->start;
      if (!t->start || ptrace(PT_SETOPTIONS, p, 0, (long)OPTS) < 0) {
        trace_error = 1;
        break;
      }
      if (resume(t, 0))
        trace_error = 1;
      continue;
    }
    if (event == EV_FORK || event == EV_VFORK || event == EV_CLONE) {
      unsigned long child = 0;
      if (ptrace(PT_GETEVENTMSG, p, 0, &child) < 0 || !child ||
          child > 2147483647UL) {
        trace_error = 1;
        break;
      }
      struct task *c = slot((pid_t)child, 1);
      if (!c || c->registered) {
        integrity_lost = 1;
        trace_error = 1;
        break;
      }
      c->registered = 1;
      if (c->stopped) {
        c->first = 0;
        c->start = birth(c->tid);
        if (!c->start || ptrace(PT_SETOPTIONS, c->tid, 0, (long)OPTS) < 0 ||
            resume(c, 0))
          trace_error = 1;
      }
    } else if (event == EV_EXEC) {
      unsigned long previous = 0;
      if (ptrace(PT_GETEVENTMSG, p, 0, &previous) < 0 ||
          (previous && previous != (unsigned long)p)) {
        trace_error = 1;
        break;
      }
      if (emit(p, "exec", "", 0, 0, 0))
        trace_error = 1;
    } else if (event == EV_EXIT) { /* Resume to reap; do not detach. */
    } else if (sig == (SIGTRAP | 0x80)) {
      struct syscall_info info = {0};
      long n = ptrace(PT_GETINFO, p, sizeof(info), &info);
      if (n < 0 || info.arch != 0xc000003eU || (info.op != 1 && info.op != 2) ||
          (info.op == 1 && n < 80)) {
        trace_error = 1;
        break;
      }
      if (info.op == 1) {
        uint64_t nr = info.u.entry.nr, flags = 0;
        /* Reject attempts to escape descendant observation before the
         * kernel executes them. No flags or memory contents are emitted. */
        if (nr == 56)
          flags = info.u.entry.args[0];
        if (nr == 435 && (info.u.entry.args[1] < 8 ||
                          memory(p, info.u.entry.args[0], &flags, 8)))
          trace_error = 1;
        if (flags & 0x00800000ULL)
          trace_error = 1; /* CLONE_UNTRACED */
        if (nr == 101 || nr == 272 || nr == 308)
          trace_error = 1; /* ptrace/unshare/setns */
        if (nr >= 512 || nr == 425 || nr == 426 || nr == 427)
          trace_error = 1; /* x32/unknown ABI, io_uring */
        if (nr == 42 && connect_entry(p, &info))
          trace_error = 1;
      }
    } else if (sig == SIGSTOP || sig == SIGTRAP) {
      trace_error = 1;
      break;
    } else {
      if (resume(t, sig))
        trace_error = 1;
      continue;
    }
    if (!trace_error && resume(t, 0))
      trace_error = 1;
  }
  if (live() || trace_error || interrupted || !driver_alive() ||
      !root_result.latched) {
    int cleaned = cleanup();
    lifecycle("completion", 0, cleaned);
    return 125;
  }
  /* An empty task array alone is not proof of an empty kernel wait set. */
  int pending_status;
  pid_t pending = waitpid(-1, &pending_status, WALL | WNOHANG);
  if (pending != -1 || errno != ECHILD) {
    integrity_lost = 1;
    if (pending > 0) {
      if (WIFEXITED(pending_status) || WIFSIGNALED(pending_status))
        reaped_tasks++;
      else {
        kill(pending, SIGKILL);
        ptrace(PT_SYSCALL, pending, 0, (long)SIGKILL);
      }
    }
    int cleaned = cleanup();
    lifecycle("completion", 0, cleaned);
    return 125;
  }
  if (lifecycle("completion", 1, 1))
    return 125;
  return final_code(&root_result, 1);
}
#else
int main(void) {
  fputs("UNSUPPORTED_PLATFORM\n", stderr);
  return 78;
}
#endif
