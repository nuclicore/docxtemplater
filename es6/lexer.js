const {
	getUnclosedTagException,
	getUnopenedTagException,
	getDuplicateOpenTagException,
	getDuplicateCloseTagException,
	throwMalformedXml,
	throwXmlInvalid,
	XTTemplateError,
} = require("./errors.js");
const { isTextStart, isTextEnd, wordToUtf8 } = require("./doc-utils.js");

const NONE = -2;
const EQUAL = 0;
const START = -1;
const END = 1;

function inRange(range, match) {
	return range[0] <= match.offset && match.offset < range[1];
}

function updateInTextTag(part, inTextTag) {
	if (isTextStart(part)) {
		if (inTextTag) {
			throwMalformedXml(part);
		}
		return true;
	}
	if (isTextEnd(part)) {
		if (!inTextTag) {
			throwMalformedXml(part);
		}
		return false;
	}
	return inTextTag;
}

function getTag(tag) {
	let position = "";
	let start = 1;
	let end = tag.indexOf(" ");
	if (tag[tag.length - 2] === "/") {
		position = "selfclosing";
		if (end === -1) {
			end = tag.length - 2;
		}
	} else if (tag[1] === "/") {
		start = 2;
		position = "end";
		if (end === -1) {
			end = tag.length - 1;
		}
	} else {
		position = "start";
		if (end === -1) {
			end = tag.length - 1;
		}
	}
	return {
		tag: tag.slice(start, end),
		position,
	};
}

function tagMatcher(content, textMatchArray, othersMatchArray) {
	let cursor = 0;
	const contentLength = content.length;

	const allMatches = {};
	for (let i = 0, len = textMatchArray.length; i < len; i++) {
		allMatches[textMatchArray[i]] = true;
	}
	for (let i = 0, len = othersMatchArray.length; i < len; i++) {
		allMatches[othersMatchArray[i]] = false;
	}
	const totalMatches = [];

	while (cursor < contentLength) {
		cursor = content.indexOf("<", cursor);
		if (cursor === -1) {
			break;
		}
		const offset = cursor;
		const nextOpening = content.indexOf("<", cursor + 1);
		cursor = content.indexOf(">", cursor);
		if (cursor === -1 || (nextOpening !== -1 && cursor > nextOpening)) {
			throwXmlInvalid(content, offset);
		}
		const tagText = content.slice(offset, cursor + 1);
		const { tag, position } = getTag(tagText);
		const text = allMatches[tag];
		if (text == null) {
			continue;
		}
		totalMatches.push({
			type: "tag",
			position,
			text,
			offset,
			value: tagText,
			tag,
		});
	}

	return totalMatches;
}

function getDelimiterErrors(delimiterMatches, fullText) {
	const errors = [];
	let inDelimiter = false;
	let lastDelimiterMatch = { offset: 0 };
	let xtag;
	delimiterMatches.forEach(function (delimiterMatch) {
		xtag = fullText.substr(
			lastDelimiterMatch.offset,
			delimiterMatch.offset - lastDelimiterMatch.offset
		);
		if (
			(delimiterMatch.position === "start" && inDelimiter) ||
			(delimiterMatch.position === "end" && !inDelimiter)
		) {
			if (delimiterMatch.position === "start") {
				if (
					lastDelimiterMatch.offset + lastDelimiterMatch.length ===
					delimiterMatch.offset
				) {
					xtag = fullText.substr(
						lastDelimiterMatch.offset,
						delimiterMatch.offset -
							lastDelimiterMatch.offset +
							lastDelimiterMatch.length +
							4
					);
					errors.push(
						getDuplicateOpenTagException({
							xtag,
							offset: lastDelimiterMatch.offset,
						})
					);
				} else {
					errors.push(
						getUnclosedTagException({
							xtag: wordToUtf8(xtag),
							offset: lastDelimiterMatch.offset,
						})
					);
				}
				delimiterMatch.error = true;
			} else {
				if (
					lastDelimiterMatch.offset + lastDelimiterMatch.length ===
					delimiterMatch.offset
				) {
					xtag = fullText.substr(
						lastDelimiterMatch.offset - 4,
						delimiterMatch.offset -
							lastDelimiterMatch.offset +
							4 +
							lastDelimiterMatch.length
					);
					errors.push(
						getDuplicateCloseTagException({
							xtag,
							offset: lastDelimiterMatch.offset,
						})
					);
				} else {
					errors.push(
						getUnopenedTagException({ xtag, offset: delimiterMatch.offset })
					);
				}
				delimiterMatch.error = true;
			}
		} else {
			inDelimiter = !inDelimiter;
		}
		lastDelimiterMatch = delimiterMatch;
	});
	const delimiterMatch = { offset: fullText.length };
	xtag = fullText.substr(
		lastDelimiterMatch.offset,
		delimiterMatch.offset - lastDelimiterMatch.offset
	);
	if (inDelimiter) {
		errors.push(
			getUnclosedTagException({
				xtag: wordToUtf8(xtag),
				offset: lastDelimiterMatch.offset,
			})
		);
		delimiterMatch.error = true;
	}
	return errors;
}

function compareOffsets(startOffset, endOffset) {
	if (startOffset === -1 && endOffset === -1) {
		return NONE;
	}
	if (startOffset === endOffset) {
		return EQUAL;
	}
	if (startOffset === -1 || endOffset === -1) {
		return endOffset < startOffset ? START : END;
	}
	return startOffset < endOffset ? START : END;
}

function splitDelimiters(inside) {
	const newDelimiters = inside.split(" ");
	if (newDelimiters.length !== 2) {
		const err = new XTTemplateError("New Delimiters cannot be parsed");
		err.properties = {
			id: "change_delimiters_invalid",
			explanation: "Cannot parser delimiters",
		};
		throw err;
	}
	const [start, end] = newDelimiters;
	if (start.length === 0 || end.length === 0) {
		const err = new XTTemplateError("New Delimiters cannot be parsed");
		err.properties = {
			id: "change_delimiters_invalid",
			explanation: "Cannot parser delimiters",
		};
		throw err;
	}
	return [start, end];
}

function getAllIndexes(fullText, delimiters) {
	const indexes = [];
	let { start, end } = delimiters;
	let offset = -1;
	let insideTag = false;
	while (true) {
		const startOffset = fullText.indexOf(start, offset + 1);
		const endOffset = fullText.indexOf(end, offset + 1);
		let position = null;
		let len;
		let compareResult = compareOffsets(startOffset, endOffset);
		if (compareResult === NONE) {
			return indexes;
		}
		if (compareResult === EQUAL) {
			if (!insideTag) {
				compareResult = START;
			} else {
				compareResult = END;
			}
		}
		if (compareResult === END) {
			insideTag = false;
			offset = endOffset;
			position = "end";
			len = end.length;
		}
		if (compareResult === START) {
			insideTag = true;
			offset = startOffset;
			position = "start";
			len = start.length;
		}
		if (position === "start" && fullText[offset + start.length] === "=") {
			indexes.push({
				offset: startOffset,
				position: "start",
				length: start.length,
				changedelimiter: true,
			});
			const nextEqual = fullText.indexOf("=", offset + start.length + 1);
			const endOffset = fullText.indexOf(end, nextEqual + 1);

			indexes.push({
				offset: endOffset,
				position: "end",
				length: end.length,
				changedelimiter: true,
			});
			const insideTag = fullText.substr(
				offset + start.length + 1,
				nextEqual - offset - start.length - 1
			);
			[start, end] = splitDelimiters(insideTag);
			offset = endOffset;
			continue;
		}
		indexes.push({ offset, position, length: len });
	}
}

function parseDelimiters(innerContentParts, delimiters) {
	const full = innerContentParts.map((p) => p.value).join("");
	const delimiterMatches = getAllIndexes(full, delimiters);

	let offset = 0;
	const ranges = innerContentParts.map(function (part) {
		offset += part.value.length;
		return { offset: offset - part.value.length, lIndex: part.lIndex };
	});

	const errors = getDelimiterErrors(delimiterMatches, full, ranges);
	let cutNext = 0;
	let delimiterIndex = 0;

	const parsed = ranges.map(function (p, i) {
		const { offset } = p;
		const range = [offset, offset + innerContentParts[i].value.length];
		const partContent = innerContentParts[i].value;
		const delimitersInOffset = [];
		while (
			delimiterIndex < delimiterMatches.length &&
			inRange(range, delimiterMatches[delimiterIndex])
		) {
			delimitersInOffset.push(delimiterMatches[delimiterIndex]);
			delimiterIndex++;
		}
		const parts = [];
		let cursor = 0;
		if (cutNext > 0) {
			cursor = cutNext;
			cutNext = 0;
		}
		let insideDelimiterChange;
		delimitersInOffset.forEach(function (delimiterInOffset) {
			const value = partContent.substr(
				cursor,
				delimiterInOffset.offset - offset - cursor
			);
			if (value.length > 0) {
				if (insideDelimiterChange) {
					if (delimiterInOffset.changedelimiter) {
						cursor =
							delimiterInOffset.offset - offset + delimiterInOffset.length;
						insideDelimiterChange = delimiterInOffset.position === "start";
					}
					return;
				}
				parts.push({ type: "content", value });
				cursor += value.length;
			}
			const delimiterPart = {
				type: "delimiter",
				position: delimiterInOffset.position,
				offset: cursor + offset,
			};
			if (delimiterInOffset.changedelimiter) {
				insideDelimiterChange = delimiterInOffset.position === "start";
				cursor = delimiterInOffset.offset - offset + delimiterInOffset.length;
				return;
			}
			parts.push(delimiterPart);
			cursor = delimiterInOffset.offset - offset + delimiterInOffset.length;
		});
		cutNext = cursor - partContent.length;
		const value = partContent.substr(cursor);
		if (value.length > 0) {
			parts.push({ type: "content", value });
		}
		return parts;
	}, this);
	return { parsed, errors };
}

function getContentParts(xmlparsed) {
	return xmlparsed.filter(function (part) {
		return part.type === "content" && part.position === "insidetag";
	});
}

function decodeContentParts(xmlparsed) {
	let inTextTag = false;
	xmlparsed.forEach(function (part) {
		inTextTag = updateInTextTag(part, inTextTag);
		if (part.type === "content") {
			part.position = inTextTag ? "insidetag" : "outsidetag";
		}
		if (inTextTag && part.type === "content") {
			part.value = part.value.replace(/>/g, "&gt;");
			// if (inTextTag) {
			// 	part.value = wordToUtf8(part.value);
			// }
		}
	});
}

module.exports = {
	parseDelimiters,
	parse(xmlparsed, delimiters) {
		decodeContentParts(xmlparsed);
		const { parsed: delimiterParsed, errors } = parseDelimiters(
			getContentParts(xmlparsed),
			delimiters
		);

		const lexed = [];
		let index = 0;
		let lIndex = 0;
		xmlparsed.forEach(function (part) {
			if (part.type === "content" && part.position === "insidetag") {
				Array.prototype.push.apply(
					lexed,
					delimiterParsed[index].map(function (p) {
						if (p.type === "content") {
							p.position = "insidetag";
						}
						p.lIndex = lIndex++;
						return p;
					})
				);
				index++;
			} else {
				part.lIndex = lIndex++;
				lexed.push(part);
			}
		});
		return { errors, lexed };
	},
	xmlparse(content, xmltags) {
		const matches = tagMatcher(content, xmltags.text, xmltags.other);
		let cursor = 0;
		const parsed = matches.reduce(function (parsed, match) {
			const value = content.substr(cursor, match.offset - cursor);
			if (value.length > 0) {
				parsed.push({ type: "content", value });
			}
			cursor = match.offset + match.value.length;
			delete match.offset;
			parsed.push(match);
			return parsed;
		}, []);
		const value = content.substr(cursor);
		if (value.length > 0) {
			parsed.push({ type: "content", value });
		}
		return parsed;
	},
};
