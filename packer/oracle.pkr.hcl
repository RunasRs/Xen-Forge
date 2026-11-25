locals {
  oracle_isolinux  = var.firmware == "bios" && contains(["8", "9"], var.os_major)
  oracle_boot_args = "inst.text inst.ks=http://{{ .HTTPIP }}:{{ .HTTPPort }}/ks.cfg ${local.boot_net_args}"
}

source "xenserver-iso" "oracle" {
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
  boot_command = local.oracle_isolinux ? [
    "<wait3>",
    "<up><wait1>",
    "<tab><wait2>",
    " ${local.oracle_boot_args}<wait>",
    "<enter>",
    ] : [
    "<wait3>",
    "<up><wait1>",
    "e<wait2>",
    "<down><down>",
    "<end>",
    " ${local.oracle_boot_args}<wait>",
    "<f10>",
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
  sources = ["xenserver-iso.oracle"]

  provisioner "file" {
    sources     = local.linux_vendor_files
    destination = "/tmp/"
  }

  provisioner "shell" {
    execute_command  = local.linux_execute_command
    environment_vars = local.linux_provision_env
    scripts = [
      "scripts/linux/10-base.sh",
      "scripts/linux/20-services.sh",
      "scripts/linux/30-profile.sh",
    ]
  }

  provisioner "shell" {
    execute_command   = local.linux_execute_command
    environment_vars  = local.linux_provision_env
    expect_disconnect = true
    skip_clean        = true
    script            = "scripts/linux/40-update.sh"
  }

  provisioner "shell" {
    execute_command     = local.linux_execute_command
    environment_vars    = local.linux_provision_env
    pause_before        = "30s"
    start_retry_timeout = "15m"
    scripts = [
      "scripts/linux/50-cleanup.sh",
      "scripts/linux/60-check.sh",
    ]
  }
}
