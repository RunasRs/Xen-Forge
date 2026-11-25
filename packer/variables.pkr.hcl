variable "remote_host" {
  type    = string
  default = null
}

variable "remote_username" {
  type    = string
  default = null
}

variable "remote_password" {
  type      = string
  sensitive = true
  default   = null
}

variable "ssh_password" {
  type      = string
  sensitive = true
  default   = null
}

variable "ssh_username" {
  type = string
}

variable "ssh_private_key_file" {
  type    = string
  default = ""
}

variable "tools_iso_name" {
  type    = string
  default = "guest-tools.iso"
}

variable "sr_name" {
  type        = string
  description = "SR where the VM disk is created"
  default     = "Local storage"
}

variable "sr_iso_name" {
  type        = string
  description = "ISO SR where the installation ISO is stored"
  default     = "ISO"
}

variable "clone_template" {
  type        = string
  description = "Base template (hardware model)"
  default     = ""
}

variable "iso_url" {
  type        = string
  description = "Installation ISO URL"
  default     = ""
}

variable "iso_checksum" {
  type        = string
  description = "ISO checksum (Packer format: sha256:... or file:...)"
  default     = ""
}

variable "vm_name" {
  type        = string
  description = "Name of the VM / resulting template"
  default     = ""
}

variable "vm_description" {
  type    = string
  default = ""
}

variable "vcpus" {
  type    = number
  default = 1
}

variable "vm_memory" {
  type        = number
  description = "Memory in MB"
  default     = 2048
}

variable "disk_size" {
  type        = number
  description = "Disk size in MB"
  default     = 10240
}

variable "network" {
  type        = string
  description = "XCP-ng network of the VM (empty = the template's network)"
  default     = ""
}

variable "os_major" {
  type    = string
  default = ""
}

variable "install_repo" {
  type    = string
  default = ""
}

variable "firmware" {
  type    = string
  default = "bios"

  validation {
    condition     = contains(["bios", "uefi"], var.firmware)
    error_message = "The firmware variable must be 'bios' or 'uefi'."
  }
}

variable "platform_args" {
  type    = map(string)
  default = {}
}

variable "disk_name" {
  type    = string
  default = ""
}

variable "vm_tags" {
  type    = list(string)
  default = []
}

variable "vm_other_config" {
  type    = map(string)
  default = {}
}

variable "network_mode" {
  type    = string
  default = "dhcp"

  validation {
    condition     = contains(["dhcp", "static"], var.network_mode)
    error_message = "The network_mode variable must be 'dhcp' or 'static'."
  }
}

variable "remove_build_user" {
  type    = string
  default = "false"
}

variable "os_update" {
  type    = string
  default = "false"
}

variable "ipv6_enabled" {
  type    = string
  default = "false"
}

variable "swap_enabled" {
  type    = string
  default = "false"
}

variable "swap_size_gb" {
  type    = string
  default = "2"
}

variable "template_profile" {
  type    = string
  default = ""
}

variable "xkb_keymap" {
  type    = string
  default = "us"
}

variable "hostname" {
  type    = string
  default = ""
}

variable "network_static_ip" {
  type    = string
  default = ""
}

variable "network_cidr" {
  type    = string
  default = ""
}

variable "command_trace" {
  type    = string
  default = "false"
}

variable "network_netmask" {
  type    = string
  default = ""
}

variable "network_gateway" {
  type    = string
  default = ""
}

variable "network_dns" {
  type    = string
  default = ""
}

variable "http_port" {
  type        = number
  description = "Packer HTTP server port for Linux recipes (same as the application's BUILD_HTTP_PORT)"
  default     = 8080
}

variable "keep_vm" {
  type        = string
  description = "Build VM retention: on_success (kept on success), always (always kept), never (deleted)"
  default     = "on_success"

  validation {
    condition     = contains(["never", "on_success", "always"], var.keep_vm)
    error_message = "The keep_vm variable must be 'never', 'on_success' or 'always'."
  }
}

locals {
  network_names = var.network == "" ? [] : [var.network]
  hostname      = trimspace(var.hostname)
  nameserver = trimspace(element(concat(compact(split(",", var.network_dns)), [var.network_gateway]), 0))

  static_network  = var.network_mode == "static"
  ipv6_kernel_arg = var.ipv6_enabled == "true" ? "" : " ipv6.disable=1"
  boot_net_args = join("", [
    local.static_network ? "ip=${var.network_static_ip}::${var.network_gateway}:${var.network_netmask}:${local.hostname}::none:${local.nameserver}" : "ip=dhcp",
    local.ipv6_kernel_arg,
  ])
  di_net_args = local.static_network ? join(" ", [
    "netcfg/disable_autoconfig=true",
    "netcfg/get_ipaddress=${var.network_static_ip} netcfg/get_netmask=${var.network_netmask}",
    "netcfg/get_gateway=${var.network_gateway} netcfg/get_nameservers=${local.nameserver}",
    "netcfg/confirm_static=true",
  ]) : ""
  suse_net_args = join("", [
    local.static_network ? "ifcfg=eth0=${var.network_static_ip}/${var.network_cidr},${var.network_gateway},${local.nameserver}" : "ifcfg=eth0=dhcp",
    local.ipv6_kernel_arg,
  ])

  build_date     = "${formatdate("YYYY-MM-DD hh:mm", timestamp())} UTC"
  vm_description = trimspace("${var.vm_description} (build ${local.build_date})")

  linux_execute_command = "chmod +x {{ .Path }}; sudo env {{ .Vars }} {{ .Path }}"
  linux_provision_env = [
    "DEBIAN_FRONTEND=noninteractive",
    "NET_MODE=${var.network_mode}",
    "OS_UPDATE=${var.os_update}",
    "IPV6_ENABLED=${var.ipv6_enabled}",
    "SWAP_ENABLED=${var.swap_enabled}",
    "SWAP_SIZE_GB=${var.swap_size_gb}",
    "TEMPLATE_PROFILE=${var.template_profile}",
    "BUILD_DATE=${local.build_date}",
    "BUILD_USER=${var.ssh_username}",
    "REMOVE_BUILD_USER=${var.remove_build_user}",
    "COMMAND_TRACE=${var.command_trace}",
  ]
  linux_vendor_files = [
    "vendor/linux/SHA256SUMS",
    "vendor/linux/xen-guest-agent.deb",
    "vendor/linux/xen-guest-agent.rpm",
  ]

}
