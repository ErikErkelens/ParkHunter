param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 52002,
    [int]$PauseSeconds = 5,
    [string[]]$FrequenciesKHz = @("7030", "7060", "14060"),
    [string]$Mode = "CW",
    [int]$SequenceIndex = 5,
    [string]$SequenceName = ""
)

$ErrorActionPreference = "Stop"

function New-AdifField {
    param(
        [string]$Name,
        [string]$Value
    )

    return "<$Name`:$($Value.Length)>$Value"
}

function New-SetFreqModeCommand {
    param(
        [string]$FrequencyKHz,
        [string]$Mode
    )

    $parameters = @(
        New-AdifField "xcvrfreq" $FrequencyKHz
        New-AdifField "xcvrmode" $Mode
        New-AdifField "preservesplitanddual" "N"
    ) -join ""

    return "$(New-AdifField "command" "CmdSetFreqMode")$(New-AdifField "parameters" $parameters)"
}

function New-SequenceCommand {
    if ($SequenceName.Trim().Length -gt 0) {
        $name = $SequenceName.Trim()
        return "$(New-AdifField "command" "seqname")$(New-AdifField "parameters" (New-AdifField "1" $name))"
    }

    $indexText = [string]$SequenceIndex
    return "$(New-AdifField "command" "seqindex")$(New-AdifField "parameters" (New-AdifField "1" $indexText))"
}

function Send-CommanderCommand {
    param([string]$Command)

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connectTask = $client.ConnectAsync($HostName, $Port)
        if (-not $connectTask.Wait(3500)) {
            throw "Timed out connecting to Commander at $HostName`:$Port."
        }

        $bytes = [Text.Encoding]::ASCII.GetBytes($Command)
        $stream = $client.GetStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally {
        $client.Close()
    }
}

if ($FrequenciesKHz.Count -eq 0) {
    throw "Provide at least one frequency in kHz."
}

$sequenceDescription = if ($SequenceName.Trim().Length -gt 0) {
    "seqname '$($SequenceName.Trim())'"
} else {
    "seqindex $SequenceIndex"
}

Write-Host "Commander XIT sequence repro"
Write-Host "Target: $HostName`:$Port"
Write-Host "Sequence: $($FrequenciesKHz -join ' -> ') kHz $Mode"
Write-Host "Commander sequence: $sequenceDescription"
Write-Host "Press Ctrl+C to stop."

$index = 0
while ($true) {
    $frequencyKHz = $FrequenciesKHz[$index % $FrequenciesKHz.Count]
    $time = Get-Date -Format "HH:mm:ss"
    Write-Host "$time set $frequencyKHz kHz $Mode"
    Send-CommanderCommand (New-SetFreqModeCommand $frequencyKHz $Mode)

    Write-Host "$time run $sequenceDescription"
    Send-CommanderCommand (New-SequenceCommand)

    $index += 1
    Start-Sleep -Seconds $PauseSeconds
}
