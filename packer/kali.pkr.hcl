locals {
  kali_boot_args = join("", [
    "auto=true priority=critical keymap=${var.xkb_keymap} ",
    "url=http://{{ .HTTPIP }}:{{ .HTTPPort }}/preseed.cfg ",
    "interface=auto ${local.di_net_args} ",
    "hostname=${local.hostname} domain=${local.ipv6_kernel_arg} ",
    "--- net.ifnames=0",
  ])
}

source "xenserver-iso" "kali" {
  remote_host     = var.remote_host
  remote_username = var.remote_username
  remote_password = var.remote_password

  sr_name     = var.sr_name
  sr_iso_name = var.sr_iso_name

  iso_url      = var.iso_url
  iso_checksum = var.iso_checksum

  clone_template  = var.clone_template
  network_names   = local.network_names
  firmware        = var.firmware
  platform_args   = var.platform_args
  disk_name       = var.disk_name
  vm_tags         = var.vm_tags
  vm_other_config = var.vm_other_config

  vm_name         = var.vm_name
  vm_description  = local.vm_description
  vm_memory       = var.vm_memory
  disk_size       = var.disk_size
  vcpus_max       = var.vcpus
  vcpus_atstartup = var.vcpus

  boot_wait = "5s"
  boot_command = var.firmware == "bios" ? [
    "<esc><wait>",
    "/install.amd/vmlinuz initrd=/install.amd/initrd.gz ${local.kali_boot_args}<enter>",
    ] : [
    "<wait5>c<wait3>",
    "linux /install.amd/vmlinuz ${local.kali_boot_args}<enter><wait>",
    "initrd /install.amd/initrd.gz<enter><wait>",
    "boot<enter>",
  ]

  http_directory = "http"
  http_port_min  = var.http_port
  http_port_max  = var.http_port
  ip_getter      = "http"

  ssh_username           = var.ssh_username
  ssh_password           = var.ssh_password
  ssh_private_key_file   = var.ssh_private_key_file == "" ? null : var.ssh_private_key_file
  ssh_wait_timeout       = "60m"
  ssh_handshake_attempts = 10000

  shutdown_command = ""

  keep_vm = var.keep_vm
  format  = "none"
}

build {
  sources = ["xenserver-iso.kali"]

  provisioner "file" {
    sources     = local.linux_vendor_files
    destination = "/tmp/"
  }

  provisioner "shell" {
    execute_command  = local.linux_execute_command
    environment_vars = concat(local.linux_provision_env, ["KERNEL_ARGS=net.ifnames=0"])
    scripts = [
      "scripts/linux/10-base.sh",
      "scripts/linux/20-services.sh",
      "scripts/linux/30-profile.sh",
    ]
  }

  provisioner "shell" {
    execute_command   = local.linux_execute_command
    environment_vars  = concat(local.linux_provision_env, ["KERNEL_ARGS=net.ifnames=0"])
    expect_disconnect = true
    skip_clean        = true
    script            = "scripts/linux/40-update.sh"
  }

  provisioner "shell" {
    execute_command     = local.linux_execute_command
    environment_vars    = concat(local.linux_provision_env, ["KERNEL_ARGS=net.ifnames=0"])
    pause_before        = "30s"
    start_retry_timeout = "15m"
    scripts = [
      "scripts/linux/50-cleanup.sh",
      "scripts/linux/60-check.sh",
    ]
  }
}
