import fs from 'node:fs';
import path from 'node:path';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

const refused = (rel) => new Error(`Fichier « ${rel} » du dossier de travail refusé : lien symbolique ou fichier hors du dossier du job`);
const replacedDir = () => new Error('Dossier de travail du job refusé : remplacé par un lien symbolique');

export function workFiles(work) {
  const prefix = `${work}${path.sep}`;
  const full = (rel) => path.join(work, rel);

  function openChecked(rel, flags, mode) {
    let fd;
    try {
      fd = fs.openSync(full(rel), flags | O_NOFOLLOW, mode);
    } catch (e) {
      if (e.code === 'ELOOP') throw refused(rel);
      throw e;
    }
    const real = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (real.startsWith(prefix) && fs.fstatSync(fd).isFile()) return fd;
    fs.closeSync(fd);
    if (flags & O_CREAT) fs.rmSync(real, { force: true });
    throw refused(rel);
  }

  function withFd(rel, flags, use, mode) {
    const fd = openChecked(rel, flags, mode);
    try {
      return use(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  const missing = (e) => e.code === 'ENOENT';

  function intact() {
    try {
      const st = fs.lstatSync(work);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  function requireIntact() {
    if (!intact()) throw replacedDir();
  }

  return {
    intact,

    present(rel) {
      try {
        fs.lstatSync(full(rel));
        return true;
      } catch {
        return false;
      }
    },

    remove(rel) {
      requireIntact();
      fs.rmSync(full(rel), { recursive: true, force: true });
    },

    mkdir(rel) {
      requireIntact();
      fs.mkdirSync(full(rel), { mode: PRIVATE_DIR });
      const st = fs.lstatSync(full(rel));
      if (!st.isDirectory() || st.isSymbolicLink()) throw refused(rel);
    },

    create(rel, content, mode = PRIVATE_FILE) {
      withFd(rel, O_WRONLY | O_CREAT | O_EXCL, (fd) => fs.writeSync(fd, content), mode);
    },

    signal(rel) {
      requireIntact();
      try {
        this.create(rel, '');
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (fs.lstatSync(full(rel)).isFile()) return;
        fs.unlinkSync(full(rel));
        this.create(rel, '');
      }
    },

    readChunk(rel, offset, maxBytes) {
      try {
        return withFd(rel, O_RDONLY, (fd) => {
          const length = Math.max(0, Math.min(fs.fstatSync(fd).size - offset, maxBytes));
          const buffer = Buffer.alloc(length);
          const read = length ? fs.readSync(fd, buffer, 0, length, offset) : 0;
          return buffer.subarray(0, read);
        });
      } catch (e) {
        if (missing(e)) return Buffer.alloc(0);
        throw e;
      }
    },

    readText(rel, maxBytes) {
      try {
        return withFd(rel, O_RDONLY, (fd) => {
          if (fs.fstatSync(fd).size > maxBytes) throw new Error(`Fichier « ${rel} » du dossier de travail trop gros (${maxBytes} octets au plus)`);
          return fs.readFileSync(fd, 'utf8');
        });
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },

    list(rel) {
      try {
        return fs.readdirSync(full(rel));
      } catch {
        return [];
      }
    },
  };
}
