#!/usr/bin/env node

import { zKey, r1cs } from "snarkjs"
import winston from "winston"
import blake from "blakejs"
import boxen from "boxen"
import { httpsCallable } from "firebase/functions"
import { Dirent } from "fs"
import {
  theme,
  symbols,
  emojis,
  potFilenameTemplate,
  potDownloadUrlTemplate,
  paths,
  names,
  collections
} from "../lib/constants.js"
import { handleAuthUserSignIn, onlyCoordinator } from "../lib/auth.js"
import { checkIfStorageFileExists, uploadFileToStorage } from "../lib/firebase.js"
import {
  bootstrapCommandExec,
  convertToDoubleDigits,
  customSpinner,
  estimatePoT,
  extractPoTFromFilename,
  extractPrefix,
  getCircuitMetadataFromR1csFile,
  sleep,
  terminate
} from "../lib/utils.js"
import {
  askCeremonyInputData,
  askCircuitInputData,
  askForCircuitSelectionFromLocalDir,
  askForConfirmation
} from "../lib/prompts.js"
import { cleanDir, directoryExists, downloadFileFromUrl, getDirFilesSubPaths, readFile } from "../lib/files.js"
import { Circuit, CircuitFiles, CircuitInputData, CircuitTimings } from "../../types/index.js"
import { showError } from "../lib/errors.js"

/**
 * Return the R1CS files from the current working directory.
 * @param cwd <string> - the current working directory.
 * @returns <Promise<Array<Dirent>>>
 */
const getR1CSFilesFromCwd = async (cwd: string): Promise<Array<Dirent>> => {
  // Check if the current directory contains the .r1cs files.
  const cwdFiles = await getDirFilesSubPaths(cwd)
  const cwdR1csFiles = cwdFiles.filter((file: Dirent) => file.name.includes(".r1cs"))

  if (!cwdR1csFiles.length)
    showError(`Your working directory must contain the Rank-1 Constraint System (R1CS) file for each circuit`, true)

  return cwdR1csFiles
}

/**
 * Handle one or more circuit addition for the specified ceremony.
 * @param cwd <string> - the current working directory.
 * @param cwdR1csFiles <Array<Dirent>> - the list of R1CS files in the current working directory.
 * @returns <Promise<Array<CircuitInputData>>>
 */
const handleCircuitsAddition = async (cwd: string, cwdR1csFiles: Array<Dirent>): Promise<Array<CircuitInputData>> => {
  const circuitsInputData: Array<CircuitInputData> = []

  let wannaAddAnotherCircuit = true // Loop flag.
  let circuitSequencePosition = 1 // Sequential circuit position for handling the contributions queue for the ceremony.
  let leftCircuits: Array<Dirent> = cwdR1csFiles

  // Clear directory.
  cleanDir(paths.metadataPath)

  while (wannaAddAnotherCircuit) {
    console.log(theme.bold(`\nCircuit # ${theme.magenta(`${circuitSequencePosition}`)}\n`))

    // Interactively select a circuit.
    const circuitNameWithExt = await askForCircuitSelectionFromLocalDir(leftCircuits)

    // Remove the selected circuit from the list.
    leftCircuits = leftCircuits.filter((dirent: Dirent) => dirent.name !== circuitNameWithExt)

    // Ask for circuit input data.
    const circuitInputData = await askCircuitInputData()
    // Remove .r1cs file extension.
    const circuitName = circuitNameWithExt.substring(0, circuitNameWithExt.indexOf("."))
    const circuitPrefix = extractPrefix(circuitName)

    // R1CS circuit file path.
    const r1csMetadataFilePath = `${paths.metadataPath}/${circuitPrefix}_${names.metadata}.log`
    const r1csFilePath = `${cwd}/${circuitPrefix}.r1cs`

    // Custom logger for R1CS metadata save.
    const logger = winston.createLogger({
      level: "info",
      transports: new winston.transports.File({
        filename: r1csMetadataFilePath,
        format: winston.format.printf((log) => log.message),
        level: "info"
      })
    })

    const spinner = customSpinner(`Looking for metadata...`, "clock")
    spinner.start()

    // Read .r1cs file and log/store info.
    await r1cs.info(r1csFilePath, logger)
    // Sleep to avoid logger unexpected termination.
    await sleep(2000)

    spinner.stop()

    // Store data.
    circuitsInputData.push({
      ...circuitInputData,
      name: circuitName,
      prefix: circuitPrefix,
      sequencePosition: circuitSequencePosition
    })

    console.log(`${symbols.success} Circuit metadata stored at ${theme.bold(theme.underlined(r1csMetadataFilePath))}\n`)

    // In case of negative confirmation or no more circuits left.
    if (leftCircuits.length === 0) {
      const spinner = customSpinner(`Assembling your ceremony...`, "clock")
      spinner.start()
      spinner.stop()

      wannaAddAnotherCircuit = false
    } else {
      // Ask for another circuit.
      const { confirmation } = await askForConfirmation("Want to add another circuit for the ceremony?", "Okay", "No")

      if (confirmation === false) wannaAddAnotherCircuit = false
      else circuitSequencePosition += 1
    }
  }

  return circuitsInputData
}

/**
 * Check if the smallest pot has been already downloaded.
 * @param neededPowers <number> - the representation of the constraints of the circuit in terms of powers.
 * @returns <Promise<boolean>>
 */
const checkIfPotAlreadyDownloaded = async (neededPowers: number): Promise<boolean> => {
  // Get files from dir.
  const potFiles = await getDirFilesSubPaths(paths.potPath)

  let alreadyDownloaded = false

  for (const potFile of potFiles) {
    const powers = extractPoTFromFilename(potFile.name)

    if (powers === neededPowers) alreadyDownloaded = true
  }

  return alreadyDownloaded
}

/**
 * Setup a new Groth16 zkSNARK Phase 2 Trusted Setup ceremony.
 */
const setup = async () => {
  // Custom spinner.
  let spinner

  // Circuit data state.
  let circuitsInputData: Array<CircuitInputData> = []
  const circuits: Array<Circuit> = []

  /** CORE */
  try {
    // Get current working directory.
    const cwd = process.cwd()

    const { firebaseFunctions } = await bootstrapCommandExec()

    // Setup ceremony callable Cloud Function initialization.
    const setupCeremony = httpsCallable(firebaseFunctions, "setupCeremony")

    // Handle authenticated user sign in.
    const { user, ghUsername } = await handleAuthUserSignIn()

    // Check custom claims for coordinator role.
    await onlyCoordinator(user)

    console.log(
      `${symbols.info} Current working directory: ${theme.bold(
        theme.underlined(cwd)
      )}\n\nYou are about to perform the setup for a zkSNARK Groth16 Phase2 Trusted Setup ceremony! ${
        emojis.key
      } \nYou just need to have the the Rank-1 Constraint System (R1CS) file for each circuit in your working directory when running this command!\n`
    )

    // Check if the current directory contains the .r1cs files.
    const cwdR1csFiles = await getR1CSFilesFromCwd(cwd)

    // Ask for ceremony input data.
    const ceremonyInputData = await askCeremonyInputData()
    const ceremonyPrefix = extractPrefix(ceremonyInputData.title)

    // Check for output directory.
    if (!directoryExists(paths.outputPath)) cleanDir(paths.outputPath)

    // Clean directories.
    cleanDir(paths.setupPath)
    cleanDir(paths.potPath)
    cleanDir(paths.metadataPath)
    cleanDir(paths.zkeysPath)

    // Ask to add circuits.
    circuitsInputData = await handleCircuitsAddition(cwd, cwdR1csFiles)

    // Ceremony summary.
    let summary = `${`${theme.bold(ceremonyInputData.title)}\n${theme.italic(ceremonyInputData.description)}`}
    \n${`Opens on ${theme.bold(
      theme.underlined(ceremonyInputData.startDate.toUTCString().replace("GMT", "UTC"))
    )}\nCloses on ${theme.bold(theme.underlined(ceremonyInputData.endDate.toUTCString().replace("GMT", "UTC")))}`}`

    for (let i = 0; i < circuitsInputData.length; i += 1) {
      const circuitInputData = circuitsInputData[i]

      // Read file.
      const r1csMetadataFilePath = `${paths.metadataPath}/${circuitInputData.prefix}_metadata.log`
      const circuitMetadata = readFile(r1csMetadataFilePath).toString()

      // Extract info from file.
      const curve = getCircuitMetadataFromR1csFile(circuitMetadata, /Curve: .+\n/s)
      const wires = Number(getCircuitMetadataFromR1csFile(circuitMetadata, /# of Wires: .+\n/s))
      const constraints = Number(getCircuitMetadataFromR1csFile(circuitMetadata, /# of Constraints: .+\n/s))
      const privateInputs = Number(getCircuitMetadataFromR1csFile(circuitMetadata, /# of Private Inputs: .+\n/s))
      const publicOutputs = Number(getCircuitMetadataFromR1csFile(circuitMetadata, /# of Public Inputs: .+\n/s))
      const labels = Number(getCircuitMetadataFromR1csFile(circuitMetadata, /# of Labels: .+\n/s))
      const outputs = Number(getCircuitMetadataFromR1csFile(circuitMetadata, /# of Outputs: .+\n/s))
      const pot = estimatePoT(constraints)

      // Store info.
      circuits.push({
        ...circuitInputData,
        metadata: {
          curve,
          wires,
          constraints,
          privateInputs,
          publicOutputs,
          labels,
          outputs,
          pot
        }
      })

      // Show circuit summary.
      summary += `\n\n${theme.bold(`- CIRCUIT # ${theme.bold(theme.magenta(`${circuitInputData.sequencePosition}`))}`)}
      \n${`${theme.bold(circuitInputData.name)}\n${theme.italic(circuitInputData.description)}
      \nCurve: ${theme.bold(curve)}
      \n# Wires: ${theme.bold(wires)}\n# Constraints: ${theme.bold(constraints)}\n# Private Inputs: ${theme.bold(
        privateInputs
      )}\n# Public Inputs: ${theme.bold(publicOutputs)}\n# Labels: ${theme.bold(labels)}\n# Outputs: ${theme.bold(
        outputs
      )}\n# PoT: ${theme.bold(pot)}`}`
    }

    // Show ceremony summary.
    console.log(
      boxen(summary, {
        title: theme.magenta(`CEREMONY SUMMARY`),
        titleAlignment: "center",
        textAlignment: "left",
        margin: 1,
        padding: 1
      })
    )

    // Ask for confirmation.
    const { confirmation } = await askForConfirmation("Please, confirm to create the ceremony", "Okay", "Exit")

    if (confirmation) {
      // Circuit setup.
      for (let i = 0; i < circuits.length; i += 1) {
        // Get the current circuit
        const circuit = circuits[i]

        console.log(theme.bold(`\n- SETUP FOR CIRCUIT # ${theme.magenta(`${circuit.sequencePosition}`)}\n`))

        // Check if the smallest pot has been already downloaded.
        const alreadyDownloaded = await checkIfPotAlreadyDownloaded(circuit.metadata.pot)

        // Convert to double digits powers (e.g., 9 -> 09).
        const stringifyNeededPowers = convertToDoubleDigits(circuit.metadata.pot)
        const smallestPotForCircuit = `${potFilenameTemplate}${stringifyNeededPowers}.ptau`

        if (!alreadyDownloaded) {
          // Get smallest suitable pot for circuit.
          spinner = customSpinner(
            `Downloading #${theme.bold(stringifyNeededPowers)} Powers of Tau from PPoT...`,
            "clock"
          )
          spinner.start()

          // Download PoT file.
          const potDownloadUrl = `${potDownloadUrlTemplate}${smallestPotForCircuit}`
          const destFilePath = `${paths.potPath}/${smallestPotForCircuit}`

          await downloadFileFromUrl(destFilePath, potDownloadUrl)

          spinner.stop()
          console.log(`${symbols.success} Powers of Tau #${theme.bold(stringifyNeededPowers)} correctly downloaded\n`)
        } else
          console.log(`${symbols.success} Powers of Tau #${theme.bold(stringifyNeededPowers)} already downloaded\n`)

        // Check if the smallest pot has been already uploaded.
        const alreadyUploadedPot = await checkIfStorageFileExists(
          `${ceremonyPrefix}/${names.pot}/${smallestPotForCircuit}`
        )

        // Circuit r1cs and zkey file names.
        const r1csFileName = `${circuit.prefix}.r1cs`
        const firstZkeyFileName = `${circuit.prefix}_00000.zkey`

        const r1csLocalPathAndFileName = `${cwd}/${r1csFileName}`
        const potLocalPathAndFileName = `${paths.potPath}/${smallestPotForCircuit}`
        const zkeyLocalPathAndFileName = `${paths.zkeysPath}/${firstZkeyFileName}`

        const potStoragePath = `${ceremonyPrefix}/${names.pot}`
        const r1csStoragePath = `${ceremonyPrefix}/${collections.circuits}/${circuit.prefix}`
        const zkeyStoragePath = `${ceremonyPrefix}/${collections.circuits}/${circuit.prefix}/${collections.contributions}`

        const r1csStorageFilePath = `${r1csStoragePath}/${r1csFileName}`
        const potStorageFilePath = `${potStoragePath}/${smallestPotForCircuit}`
        const zkeyStorageFilePath = `${zkeyStoragePath}/${firstZkeyFileName}`

        // Compute first .zkey file (without any contribution).
        await zKey.newZKey(r1csLocalPathAndFileName, potLocalPathAndFileName, zkeyLocalPathAndFileName, console)

        console.log(
          `\n${symbols.success} zKey ${theme.bold(theme.underlined(firstZkeyFileName))} successfully computed`
        )

        // ZKEY.
        spinner = customSpinner(`Storing zKey file...`, "clock")
        spinner.start()

        // Upload.
        await uploadFileToStorage(zkeyLocalPathAndFileName, zkeyStorageFilePath)

        spinner.stop()

        console.log(
          `${symbols.success} zKey ${theme.bold(theme.underlined(firstZkeyFileName))} successfully saved on storage`
        )

        // PoT.
        if (!alreadyUploadedPot) {
          spinner = customSpinner(`Storing Powers of Tau file...`, "clock")
          spinner.start()

          // Upload.
          await uploadFileToStorage(potLocalPathAndFileName, potStorageFilePath)

          spinner.stop()

          console.log(
            `${symbols.success} Powers of Tau ${theme.bold(
              theme.underlined(smallestPotForCircuit)
            )} successfully saved on storage`
          )
        } else {
          console.log(
            `${symbols.success} Powers of Tau ${theme.bold(theme.underlined(smallestPotForCircuit))} already stored`
          )
        }

        // R1CS.
        spinner = customSpinner(`Storing R1CS file...`, "clock")
        spinner.start()

        // Upload.
        await uploadFileToStorage(r1csLocalPathAndFileName, r1csStorageFilePath)

        spinner.stop()

        console.log(
          `${symbols.success} R1CS ${theme.bold(theme.underlined(r1csFileName))} successfully saved on storage`
        )

        // Circuit-related files info.
        const circuitFiles: CircuitFiles = {
          files: {
            r1csFilename: r1csFileName,
            potFilename: smallestPotForCircuit,
            initialZkeyFilename: firstZkeyFileName,
            r1csStoragePath: r1csStorageFilePath,
            potStoragePath: potStorageFilePath,
            initialZkeyStoragePath: zkeyStorageFilePath,
            r1csBlake2bHash: blake.blake2bHex(r1csStorageFilePath),
            potBlake2bHash: blake.blake2bHex(potStorageFilePath),
            initialZkeyBlake2bHash: blake.blake2bHex(zkeyStorageFilePath)
          }
        }

        const circuitTimings: CircuitTimings = {
          avgTimings: {
            avgContributionTime: 0,
            avgVerificationTime: 0
          }
        }

        circuits[i] = {
          ...circuit,
          ...circuitFiles,
          ...circuitTimings
        }
      }

      /** POPULATE DB */
      spinner = customSpinner(`Storing the ceremony data on the db...`, "clock")
      spinner.start()

      // Setup ceremony on the server.
      await setupCeremony({
        ceremonyInputData,
        ceremonyPrefix,
        circuits
      })
      await sleep(2000)

      spinner.stop()

      console.log(
        `\nYou have successfully completed your ${theme.bold(
          ceremonyInputData.title
        )} ceremony setup! Congratulations, @${theme.bold(ghUsername)} ${emojis.tada}`
      )
    }

    terminate(ghUsername)
  } catch (err: any) {
    showError(`Something went wrong: ${err.toString()}`, true)
  }
}

export default setup