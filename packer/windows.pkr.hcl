# os_update:begin
packer {
  required_plugins {
    windows-update = {
      source  = "github.com/rgl/windows-update"
      version = "0.18.5"
    }
  }
}
# os_update:end

source "xenserver-iso" "windows" {
  remote_host     = var.remote_host
  remote_username = var.remote_username
  remote_password = var.remote_password

  sr_name     = var.sr_name
  sr_iso_name = var.sr_iso_name

  iso_url      = var.iso_url
  iso_checksum = var.iso_checksum == "" ? "none" : var.iso_checksum

  clone_template  = var.clone_template
  network_names   = local.network_names
  firmware        = var.firmware
  platform_args   = var.platform_args
  disk_name       = var.disk_name
  vm_tags         = var.vm_tags
  vm_other_config = var.vm_other_config

  tools_iso_name = var.tools_iso_name

  vm_name         = var.vm_name
  vm_description  = local.vm_description
  vm_memory       = var.vm_memory
  disk_size       = var.disk_size
  vcpus_max       = var.vcpus
  vcpus_atstartup = var.vcpus

  boot_wait    = var.firmware == "bios" ? "10s" : "2s"
  boot_command = var.firmware == "bios" ? ["<spacebar>"] : [
    "<spacebar><wait1><spacebar><wait1><spacebar><wait1><spacebar><wait1><spacebar><wait1>",
    "<spacebar><wait1><spacebar><wait1><spacebar><wait1><spacebar><wait1><spacebar><wait1>",
    "<spacebar><wait1><spacebar><wait1><spacebar><wait1><spacebar><wait1><spacebar><wait1>",
    "<spacebar><wait1><spacebar><wait1><spacebar><wait1><spacebar><wait1><spacebar>",
  ]

  ip_getter       = "tools"
  install_timeout = "90m"

  cd_files = ["cd/autounattend.xml", "cd/xentools.ps1"]

  ssh_username           = var.ssh_username
  ssh_password           = var.ssh_password
  ssh_wait_timeout       = "60m"
  ssh_handshake_attempts = 10000

  shutdown_command = ""

  keep_vm = var.keep_vm
  format  = "none"
}

build {
  sources = ["xenserver-iso.windows"]

  provisioner "file" {
    sources = [
      "vendor/windows/CloudbaseInitSetup.msi",
      "scripts/windows/packer-10-base.ps1",
      "scripts/windows/packer-20-profile.ps1",
      "scripts/windows/packer-30-prepare.ps1",
    ]
    destination = "C:/Windows/Temp/"
  }

  provisioner "windows-shell" {
    inline = [
      "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Windows\\Temp\\packer-10-base.ps1 || exit /b 1",
      "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Windows\\Temp\\packer-20-profile.ps1 || exit /b 1",
    ]
  }

  # os_update:begin
  provisioner "windows-update" {
    search_criteria = "IsInstalled=0"
    filters = [
      "exclude:$_.Title -like '*Preview*'",
      "include:$true",
    ]
  }
  # os_update:end

  provisioner "windows-shell" {
    inline = [
      "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Windows\\Temp\\packer-30-prepare.ps1 || exit /b 1",
    ]
  }
}
