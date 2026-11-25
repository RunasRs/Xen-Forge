import { app, view } from './page.js';
import { batch, pagedSource } from './api.js';
import { emptyCell, oneLine, stack, when } from './display.js';
import { dataTable } from './table.js';
import { deleteConfirm } from './modal.js';
import { cloneProfile, lastJobCell, profileIdle, profilesCard } from './distributions.js';
import { launchMany } from './jobs.js';
import { profileModal } from './profile-modal.js';

const editProfile = (existing, copy = null) => profileModal(existing, copy, () => pageProfiles());

export async function pageProfiles(gen = view.pageGen) {
  const t = await dataTable({
    key: 'packer-profiles',
    source: pagedSource('/profiles'),
    card: profilesCard('packer'),
    search: true,
    empty: 'Aucun profil Packer : créez-en un pour construire un template.',
    create: { label: 'Ajouter', run: () => editProfile(null) },
    poll: 5000,
    columns: [
      ['Profil', (p) => stack(p.name), '20%', 'name'],
      ['Description', (p) => (p.description ? oneLine(p.description) : emptyCell()), '20%', 'description'],
      ['Template', (p) => (p.vars.vm_name ? oneLine(p.vars.vm_name) : emptyCell()), '20%', 'template'],
      ['Dernier job', lastJobCell('packer'), '14%', 'last_job:desc'],
      ['Validation', (p) => when(p.validated_at), '13%', 'validated:desc'],
      ['Construction', (p) => when(p.built_at), '13%', 'built:desc'],
    ],
    actions: [
      { label: 'Modifier', when: 'one', reload: false, run: ([p]) => editProfile(p) },
      { label: 'Cloner', when: 'one', reload: false, run: ([p]) => cloneProfile('/profiles', p, editProfile) },
      { label: 'Valider', when: 'many', allow: profileIdle, run: (sel) => launchMany('packer', 'validate', sel) },
      { label: 'Construire', when: 'many', allow: profileIdle,
        confirm: (sel) => ({
          title: 'Lancer la construction',
          message: sel.length > 1
            ? `Lancer la construction de ${sel.length} profils ? Une VM de build sera créée sur XCP-ng pour chacun.`
            : `Lancer le build « ${sel[0].name} » ? Une VM de build sera créée sur XCP-ng.`,
        }),
        run: (sel) => launchMany('packer', 'build', sel) },
      { label: 'Supprimer', when: 'many', danger: true, allow: profileIdle,
        confirm: (sel) => deleteConfirm(sel, ['le profil', 'les profils'], (p) => p.name),
        run: (sel) => batch('/profiles/batch', 'delete', sel) },
    ],
  });
  if (gen !== view.pageGen) return;
  app.replaceChildren(t.el);
}
