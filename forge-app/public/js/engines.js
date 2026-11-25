import { plural } from './format.js';

export const ENGINE_CARDS = {
  packer: {
    name: 'Packer',
    subtitle: 'Construction des templates',
    icon: 'M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7zM2.5 4.5L8 7.5l5.5-3M8 7.5v7',
    asset: (st) => ({ label: 'Templates', value: st.built, of: st.profiles, sub: 'profils', title: `Templates sur ${plural(st.profiles, 'profil', 'profils')}` }),
  },
  tofu: {
    name: 'OpenTofu',
    subtitle: 'Déploiement des VMs',
    icon: 'M8 1.5l6 3-6 3-6-3zM2 8l6 3 6-3M2 11.5l6 3 6-3',
    asset: (st) => ({ label: 'Déployées', value: st.deployed, of: st.profiles, sub: 'profils', title: `VMs déployées sur ${plural(st.profiles, 'profil', 'profils')}` }),
  },
  ansible: {
    name: 'Ansible',
    subtitle: 'Configuration et administration des serveurs',
    icon: 'M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM5.5 11.5L8 4.5l2.5 7M6.4 9h3.2',
    asset: (st) => ({ label: 'Appliqués', value: st.applied, of: st.profiles, sub: 'profils', title: `Appliqués sur ${plural(st.profiles, 'profil', 'profils')}` }),
  },
};
