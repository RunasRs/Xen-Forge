terraform {
  required_version = ">= 1.8.0"

  required_providers {
    xenorchestra = {
      source = "vatesfr/xenorchestra"
      version = ">= 0.41.2"
    }
  }

  backend "pg" {}
}

provider "xenorchestra" {}

variable "pool_id" {
  description = "Target XCP-ng pool UUID (disambiguates when Xen Orchestra manages several pools)"
  type        = string
  default     = null
}

variable "template" {
  description = "Source template name (name-label)"
  type        = string
}

variable "sr_id" {
  description = "UUID of the SR hosting the VM disk"
  type        = string
}

variable "network" {
  description = "XCP-ng network name of the VM"
  type        = string
}

variable "vm_name" {
  type = string
}

variable "vm_description" {
  type    = string
  default = ""
}

variable "cpus" {
  type = number
}

variable "memory_mb" {
  type = number
}

variable "cores_per_socket" {
  description = "Cores per socket (divisor of cpus), always set by the application (1 by default)"
  type        = number
  default     = null
}

variable "disk_gb" {
  description = "System disk size in GB (>= template disk: grown, never shrunk)"
  type        = number
}

variable "disk_name" {
  description = "System disk name"
  type        = string
}

variable "extra_disks" {
  description = "Additional raw (unformatted) disks, attached after the system disk"
  type = list(object({
    name    = string
    sr_id   = string
    size_gb = number
  }))
  default = []
}

variable "clone_type" {
  description = "Template clone: \"full\" (dedicated disk, full copy) or \"fast\" (disk linked to the template)"
  type        = string
  default     = "full"

  validation {
    condition     = contains(["full", "fast"], var.clone_type)
    error_message = "Invalid clone_type: expected \"full\" or \"fast\"."
  }
}

variable "tags" {
  type    = list(string)
  default = []
}

variable "resource_set_tags" {
  description = "Self-service group tags, for an existing VM (on creation, Xen Orchestra sets them itself)"
  type        = list(string)
  default     = []
}

variable "mac_address" {
  description = "Fixed MAC address of the interface, targeted by the cloud-init network-config"
  type        = string
  default     = null
}

variable "extra_networks" {
  description = "Additional interfaces (network, fixed MAC targeted by the network-config)"
  type = list(object({
    network = string
    mac     = string
  }))
  default = []
}

variable "affinity_host" {
  description = "Preferred host of the VM (name-label); empty: none; __master__: pool master"
  type        = string
  default     = ""
}

variable "auto_poweron" {
  description = "Start the VM when its host boots"
  type        = bool
  default     = true
}

variable "blocked_operations" {
  description = "XAPI operations blocked on the VM (protection against deletion, shutdown and migration)"
  type        = list(string)
  default     = []
}

variable "high_availability" {
  description = "VM HA priority; empty: disabled"
  type        = string
  default     = ""

  validation {
    condition     = contains(["", "best-effort", "restart"], var.high_availability)
    error_message = "Invalid high_availability: expected empty, \"best-effort\" or \"restart\"."
  }
}

variable "hvm_boot_firmware" {
  description = "Boot firmware, matching the system installed on the template"
  type        = string
  default     = "bios"

  validation {
    condition     = contains(["bios", "uefi"], var.hvm_boot_firmware)
    error_message = "Invalid hvm_boot_firmware: expected \"bios\" or \"uefi\"."
  }
}

variable "secure_boot" {
  description = "UEFI Secure Boot (no effect with BIOS)"
  type        = bool
  default     = false
}

variable "vga" {
  description = "Graphics adapter: \"std\" (VGA enabled) or \"cirrus\" (VGA disabled)"
  type        = string
  default     = "std"

  validation {
    condition     = contains(["std", "cirrus"], var.vga)
    error_message = "Invalid vga: expected \"std\" or \"cirrus\"."
  }
}

variable "videoram" {
  description = "Video memory in MiB"
  type        = number
  default     = 8

  validation {
    condition     = contains([1, 2, 4, 8, 16], var.videoram)
    error_message = "Invalid videoram: expected 1, 2, 4, 8 or 16."
  }
}

variable "resource_set" {
  description = "Self-service group (resource set) of the VM; empty: none"
  type        = string
  default     = ""
}

variable "resource_set_share" {
  description = "Share the VM with the self-service group members"
  type        = bool
  default     = false
}

variable "acls" {
  description = "Xen Orchestra ACLs on the VM: subject (XO user or group) and role"
  type = list(object({
    subject = string
    role    = string
  }))
  default = []

  validation {
    condition     = alltrue([for a in var.acls : contains(["admin", "operator", "viewer"], a.role)])
    error_message = "Invalid acls: role must be \"admin\", \"operator\" or \"viewer\"."
  }
}

variable "cloud_config" {
  description = "cloud-init or cloudbase-init user-data (null: no config drive)"
  type        = string
  default     = null
  sensitive   = true
}

variable "cloud_network_config" {
  description = "cloud-init or cloudbase-init network-config, version 1 format"
  type        = string
  default     = null
}

variable "destroy_cloud_config" {
  description = "Remove the config drive once the VM has booted (cloud-init disabled by the user-data)"
  type        = bool
  default     = false
}

variable "expected_ip_cidr" {
  description = "IP range expected on the interface (guest agent required); empty: no wait"
  type        = string
  default     = ""
}

variable "destroy_mode" {
  description = "Destroy mode: no data source is read (the provider destroys by the state ID), so that a missing template, SR, network or host does not block the destroy"
  type        = bool
  default     = false
}

data "xenorchestra_template" "this" {
  count      = var.destroy_mode ? 0 : 1
  name_label = var.template
  pool_id    = var.pool_id
}

data "xenorchestra_network" "this" {
  count      = var.destroy_mode ? 0 : 1
  name_label = var.network
  pool_id    = var.pool_id
}

data "xenorchestra_network" "extra" {
  for_each   = var.destroy_mode ? toset([]) : toset([for n in var.extra_networks : n.network])
  name_label = each.value
  pool_id    = var.pool_id
}

data "xenorchestra_hosts" "pool" {
  count   = var.destroy_mode || var.affinity_host != "__master__" ? 0 : 1
  pool_id = var.pool_id
}

data "xenorchestra_host" "affinity" {
  count      = var.destroy_mode || var.affinity_host == "" || var.affinity_host == "__master__" ? 0 : 1
  name_label = var.affinity_host
}

data "xenorchestra_resource_set" "this" {
  count = var.destroy_mode || var.resource_set == "" ? 0 : 1
  name  = var.resource_set
}

resource "xenorchestra_vm" "this" {
  name_label       = var.vm_name
  name_description = var.vm_description
  template         = var.destroy_mode ? "" : data.xenorchestra_template.this[0].id
  clone_type       = var.clone_type

  cpus             = var.cpus
  cores_per_socket = var.cores_per_socket
  memory_max       = var.memory_mb * 1024 * 1024
  memory_min       = var.memory_mb * 1024 * 1024

  power_state  = "Running"
  auto_poweron = var.auto_poweron

  blocked_operations = var.blocked_operations
  high_availability  = var.high_availability
  hvm_boot_firmware  = var.hvm_boot_firmware
  secure_boot        = var.secure_boot
  vga                = var.vga
  videoram           = var.videoram

  affinity_host = var.destroy_mode || var.affinity_host == "" ? null : var.affinity_host == "__master__" ? data.xenorchestra_hosts.pool[0].master : data.xenorchestra_host.affinity[0].id
  resource_set  = var.destroy_mode || var.resource_set == "" ? null : data.xenorchestra_resource_set.this[0].id
  share         = var.destroy_mode || var.resource_set == "" ? null : var.resource_set_share

  cloud_config         = var.cloud_config
  cloud_network_config = var.cloud_network_config

  destroy_cloud_config_vdi_after_boot = var.destroy_mode ? false : var.destroy_cloud_config

  network {
    network_id       = var.destroy_mode ? "" : data.xenorchestra_network.this[0].id
    mac_address      = var.mac_address
    expected_ip_cidr = var.expected_ip_cidr
  }

  dynamic "network" {
    for_each = var.extra_networks
    content {
      network_id  = data.xenorchestra_network.extra[network.value.network].id
      mac_address = network.value.mac
    }
  }

  disk {
    sr_id      = var.sr_id
    name_label = var.disk_name
    size       = var.disk_gb * 1024 * 1024 * 1024
  }

  dynamic "disk" {
    for_each = var.extra_disks
    content {
      sr_id      = disk.value.sr_id
      name_label = disk.value.name
      size       = disk.value.size_gb * 1024 * 1024 * 1024
    }
  }

  tags = var.resource_set == "" ? var.tags : distinct(concat(var.tags, var.resource_set_tags))

  timeouts {
    create = "30m"
    update = "30m"
    delete = "15m"
  }

  lifecycle {
    ignore_changes = [template, cloud_config, cloud_network_config, clone_type, network]
  }
}

resource "xenorchestra_acl" "this" {
  for_each = { for a in var.acls : a.subject => a }
  object   = xenorchestra_vm.this.id
  subject  = each.value.subject
  action   = each.value.role

  lifecycle {
    replace_triggered_by = [xenorchestra_vm.this.resource_set, xenorchestra_vm.this.share]
  }
}

output "vm_id" {
  value = xenorchestra_vm.this.id
}

output "vm_name" {
  value = xenorchestra_vm.this.name_label
}

output "ipv4_addresses" {
  value = xenorchestra_vm.this.ipv4_addresses
}

output "mac_address" {
  value = xenorchestra_vm.this.network[0].mac_address
}
