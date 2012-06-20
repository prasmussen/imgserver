#!/bin/bash

# Defaults
DEFAULT_IMGSERVER="http://10.0.0.160"
DEFAULT_DATASETS_PATH="/zones/global/datasets"
DEFAULT_VERSION="1.0.0"

if [ "$1" == "" ]; then
    echo "Usage: $0 <zonename>"
    exit 1
fi

zonename=$1

if [ "$(zoneadm list -i | grep $zonename)" != $zonename ]; then
    echo "Could not find zone '$zonename'"
    exit 1
fi

echo
echo "========================================================================="
echo "Name is a short name for the dataset."
echo "It may only contain ascii letters, numbers, hypens ('-'), periods ('.') and underscores ('_') and it must start with a letter."
echo "While capital letters are allowed, they are discouraged. The name is case-sensitive and is limited to 32 characters."
echo "Example: 'ubuntu-12.04-x86_64'"
echo
while [ "$name" == "" ]; do
    read -p "Name: " name
done
echo "========================================================================="

echo
echo "========================================================================="
echo "Version is a short version string for the dataset."
echo "It may only contain ascii letters, numbers, hypens ('-'), periods ('.') and underscores ('_')."
echo "While not enforced, it is strongly encouraged that dataset authors use the "X.Y.Z" semantic versioning"
echo "scheme described at http://semver.org/. The version is limited to 32 characters."
echo
read -p "Version ($DEFAULT_VERSION): " version
if [ "$version" == "" ]; then
    version=$DEFAULT_VERSION
fi
echo "========================================================================="

echo
echo "========================================================================="
echo "Description is a short prose description of the dataset. It is limited to 255 characters."
echo "Example: 'Ubuntu 12.04 64-bit'"
echo
while [ "$description" == "" ]; do
    read -p "Description: " description
done
echo "========================================================================="



# Collect data
uuid=$(uuid)
brand=$(vmadm get $zonename | json brand)

if [ "$brand" == "kvm" ]; then
    zvol=$(vmadm get $zonename | json disks[0].zfs_filesystem)
    disk_driver=$(vmadm get $zonename | json disks[0].model)
    nic_driver=$(vmadm get $zonename | json nics[0].model)
elif [ "$brand" == "joyent" ]; then
    zvol=$(vmadm get $zonename | json zfs_filesystem)
else
    echo "Invalid brand '$brand'"
    exit 1
fi

image_size_bytes=$(zfs get -pH volsize $zvol | awk '{ print $3 }')
image_size=$[ $image_size_bytes / (1024 * 1024) ]

# Create a temporary snapshot
snapshot_name=${zvol}@${uuid}
echo "Creating snapshot..."
zfs snapshot $snapshot_name
if [ $? -gt 0 ]; then
    echo "Failed while creating snapshot '$snapshot_name'"
    exit 1
fi

echo
echo "========================================================================="
echo "Enter path to store the dataset image"
echo
read -p "Path ($DEFAULT_DATASETS_PATH): " datasets_path
if [ "$datasets_path" == "" ]; then
    datasets_path=$DEFAULT_DATASETS_PATH
fi
echo "========================================================================="

# Create datasets directory if it does not exist
mkdir -p "$datasets_path"

archive_name="${name}.bz2"
archive_path="${datasets_path}/${archive_name}"
echo
echo "Exporting image to bzip2 archive ($archive_path)"
zfs send $snapshot_name | bzip2 > $archive_path
zfs_send_status=$?

# Snapshot should be removed even if zfs send failed
echo "Removing snapshot"
zfs destroy $snapshot_name

if [ $zfs_send_status -gt 0 ]; then
    echo "Failed while exporting snapshot '$snapshot_name'"
    exit 1
fi

echo "Generating sha checksum..."
archive_sha=$(cksum -xsha1 $archive_path | awk '{ print $1 }')
archive_size=$(ls -l $archive_path | awk '{ print $5 }')


kvm_manifest_template='{
    "uuid": "{{uuid}}",
    "name": "{{name}}",
    "version": "{{version}}",
    "description": "{{description}}",
    "type": "zvol",
    "os": "linux",
    "nic_driver": "{{nic_driver}}",
    "disk_driver": "{{disk_driver}}",
    "image_size": "{{image_size}}",
    "files": [
        {
            "path": "{{archive_name}}",
            "sha1": "{{archive_sha}}",
            "size": {{archive_size}}
        }
    ],
    "requirements": {
        "networks": [
            {
                "name": "net0",
                "description": "public"
            }
        ],
        "ssh_key": true
    }
}'

# Replace placeholders in template
declare -A tags
tags[uuid]=$uuid
tags[name]=$name
tags[version]=$version
tags[description]=$description
tags[nic_driver]=$nic_driver
tags[disk_driver]=$disk_driver
tags[image_size]=$image_size
tags[archive_name]=$archive_name
tags[archive_sha]=$archive_sha
tags[archive_size]=$archive_size

for tag in "${!tags[@]}"; do
    placeholder="{{$tag}}"
    value=${tags[$tag]}
    kvm_manifest_template=${kvm_manifest_template//$placeholder/$value}
done

# Save manifest to disk
echo "Saving manifest..."
manifest_path="${datasets_path}/${name}.dsmanifest"
echo $kvm_manifest_template | json > "$manifest_path"

echo
echo "========================================================================="
echo "Do you want to upload the image to a dataset server?"
echo
read -p "Upload? (Y/n): " do_upload
if [[ "$do_upload" == [Nn] ]]; then
    echo "Exiting..."
    exit 0
fi
echo "========================================================================="

echo
echo "========================================================================="
echo "Dataset server to upload the image to."
echo
read -p "Server ($DEFAULT_IMGSERVER): " imgserver
if [ "$imgserver" == "" ]; then
    imgserver=$DEFAULT_IMGSERVER
fi
echo "========================================================================="

echo
echo "Uploading image to dataset server..."
curl "${imgserver}/datasets/${uuid}" -X PUT -F "manifest=@${manifest_path}" -F "${archive_name}=@${archive_path}"

echo
echo "========================================================================="
echo "Do you want to delete the image file and dsmanifest?"
echo
read -p "Delete? (Y/n): " do_delete
if [[ "$do_delete" == [Nn] ]]; then
    echo "Exiting..."
    exit 0
fi
echo "========================================================================="

echo
echo "Removing files..."
rm $archive_path
rm $manifest_path
