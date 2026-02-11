#!/usr/bin/osascript -l JavaScript

/**
 * Export OSX Notes to markdown files
 *
 * Usage:
 *   ./export-osx-notes.js <output_dir> [account_name|all]
 *
 * This script exports notes from the OSX Notes.app to markdown files.
 * Each note becomes a separate .md file, preserving folder structure.
 * Files are named using note ID to ensure uniqueness and prevent duplicates.
 */

function run(argv) {
  const outputDir = argv[0];
  const accountFilter = argv[1] || 'all';

  if (!outputDir) {
    console.log('Usage: export-osx-notes.js <output_dir> [account_name|all]');
    $.exit(1);
  }

  // Get reference to Notes app
  const Notes = Application('Notes');
  Notes.includeStandardAdditions = true;

  // Get FileManager for file operations
  const fm = $.NSFileManager.defaultManager;

  // Create output directory if it doesn't exist
  const outputPath = $(outputDir).stringByExpandingTildeInPath;
  fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
    outputPath, true, $(), $()
  );

  let exportedCount = 0;
  let skippedCount = 0;

  // Get all accounts
  const accounts = Notes.accounts();

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const accountName = account.name();

    // Skip if account filter specified and doesn't match
    if (accountFilter !== 'all' && accountName !== accountFilter) {
      continue;
    }

    // Sanitize account name for use in paths
    const safeAccountName = accountName.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Create account directory
    const accountDir = outputPath.stringByAppendingPathComponent(safeAccountName);
    fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
      accountDir, true, $(), $()
    );

    console.log(`Exporting from account: ${accountName}`);

    // Get all folders in this account
    const folders = account.folders();

    for (let j = 0; j < folders.length; j++) {
      const folder = folders[j];
      const folderName = folder.name();

      // Sanitize folder name
      const safeFolderName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');

      // Create folder directory
      const folderDir = accountDir.stringByAppendingPathComponent(safeFolderName);
      fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        folderDir, true, $(), $()
      );

      console.log(`  Folder: ${folderName}`);

      // Get all notes in this folder
      const notes = folder.notes();

      for (let k = 0; k < notes.length; k++) {
        const note = notes[k];
        const noteId = note.id();
        const noteName = note.name();
        const noteBody = note.body();
        const creationDate = note.creationDate();
        const modificationDate = note.modificationDate();

        // Create a unique filename using note ID
        // Extract the last part of the ID (after last /)
        const noteIdParts = noteId.split('/');
        const shortId = noteIdParts[noteIdParts.length - 1];

        // Sanitize note name for filename
        let safeNoteName = noteName.replace(/[^a-zA-Z0-9_-]/g, '_');
        // Limit filename length
        if (safeNoteName.length > 100) {
          safeNoteName = safeNoteName.substring(0, 100);
        }

        const filename = `${shortId}_${safeNoteName}.md`;
        const filePath = folderDir.stringByAppendingPathComponent(filename);

        // Build markdown content
        let markdown = `# ${noteName}\n\n`;
        markdown += `<!-- Note ID: ${noteId} -->\n`;
        markdown += `<!-- Account: ${accountName} -->\n`;
        markdown += `<!-- Folder: ${folderName} -->\n`;
        markdown += `<!-- Created: ${creationDate} -->\n`;
        markdown += `<!-- Modified: ${modificationDate} -->\n\n`;
        markdown += noteBody;

        // Write to file
        const content = $.NSString.alloc.initWithUTF8String(markdown);
        const error = $();
        content.writeToFileAtomicallyEncodingError(filePath, true, $.NSUTF8StringEncoding, error);

        if (error.js) {
          console.log(`    Error writing ${filename}: ${error.js}`);
          skippedCount++;
        } else {
          exportedCount++;
        }
      }
    }
  }

  console.log(`\nExport complete:`);
  console.log(`  Exported: ${exportedCount} notes`);
  if (skippedCount > 0) {
    console.log(`  Skipped: ${skippedCount} notes (errors)`);
  }

  return exportedCount;
}
