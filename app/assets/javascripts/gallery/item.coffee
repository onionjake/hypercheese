@Item = React.createClass
  onClick: (e) ->
    if e.ctrlKey
      Store.toggleSelection @props.item.id
    else
      @props.showItem @props.item.id

  render: ->
    item = @props.item
    selected = Store.state.selection[item.id]

    imageStyle =
      width: "#{@props.imageWidth}px"
      height: "#{@props.imageHeight}px"

    if item.id?
      squareImage = "/data/resized/square/#{item.id}.jpg"
    else
      squareImage = "/images/loading.png"

    classes = ["item"]
    classes.push 'is-selected' if selected

    maxFit = @props.imageWidth / 33
    tags = item.tag_ids || []
    tagCount = tags.length
    numberToShow = maxFit
    numberToShow-- if item.has_comments
    if tagCount > numberToShow
      numberToShow--
    firstTags = tags.slice 0, numberToShow
    extraTags = tagCount - firstTags.length

    <div className={classes.join ' '} onDblClick={@onDoubleClick} onClick={@onClick} key="#{item.index}">
      <img className="thumb" style={imageStyle} src={squareImage}/>
      <div className="tagbox">
        {
          if item.has_comments
            <img src="/images/comment.png"/>
        }
        {
          firstTags.map (tag_id) ->
            tag = Store.state.tagsById[tag_id]
            if tag
              tag_icon_url = "/data/resized/square/#{tag.icon}.jpg"
              <img className="tag-icon" key={tag_id} src={tag_icon_url}/>
        }
        {
          if extraTags > 0
            <div className="extra-tags">{'+' + extraTags}</div>
        }
      </div>
    </div>